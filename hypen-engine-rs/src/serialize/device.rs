//! Device Capability Protocol — provisional wire types (RFC 001, v2.4).
//!
//! This module is the **schema source of truth** for the device capability
//! protocol: envelope messages, control variants, owner/lifetime shapes, the
//! error taxonomy, the handshake extension with exact-revision selection, the
//! binary frame header, and the capability registry. SDK wire types and
//! validators are generated from the JSON Schemas this module exports (behind
//! the non-default `schema-export` feature).
//!
//! **Strictness contract.** The strict entry points are
//! [`DeviceMessage::decode`] (JSON text), [`DeviceMessage::decode_bytes`]
//! (raw frame bytes, checked for UTF-8), [`DeviceMessage::decode_value`],
//! the handshake decoders ([`DeviceHello::decode`], [`DeviceAck::decode`],
//! [`CapabilitiesEvent::decode`] and their `from_value` twins) and
//! [`validate_payload`]. They apply, in this order:
//!
//! 1. the RFC 001 §2.1 JSON limits ([`parse_strict_json`]): at most
//!    [`limits::MESSAGE_MAX_BYTES`] of text checked before parsing, nesting
//!    depth at most [`limits::JSON_MAX_DEPTH`] containers, integer tokens
//!    only (no fraction, exponent or `-0`) with magnitude at most 2^53 − 1,
//!    valid UTF-8 with no raw control characters and no lone surrogate
//!    escapes in keys and values, duplicate keys rejected at any depth, and
//!    only the literals `true`/`false`/`null`;
//! 2. closed typed decoding (unknown and wrong-case keys, `null` for a
//!    required or optional-but-typed member, out-of-range integers, every
//!    string/array bound with lengths in Unicode code points);
//! 3. **canonical round-trip**: re-serializing the typed value must give back
//!    the input value exactly, so an array never stands in for an object and
//!    a one-key map never stands in for an enum string (serde derives accept
//!    both; the exported schemas do not);
//! 4. rules no JSON Schema keyword expresses (owner shape vs. lifetime,
//!    unique result channels, unique capability names).
//!
//! The serde `Deserialize` impls are structural building blocks, not a strict
//! decoder: use the entry points above on untrusted input.
//!
//! The rendering engine itself is never on the device wire path. The
//! server-side protocol state machine that every server SDK shares — the
//! sans-IO [`crate::device::DeviceBroker`] — is built on these types: it
//! decodes with the strict entry points above, validates with
//! [`validate_payload`], and frames with [`FrameHeader`] / [`ChannelSeq`].
//! The frame-header codec is also the canonical reference for the
//! golden-byte fixtures of the per-SDK native client codecs.
//!
//! Everything here is **provisional**: per RFC 001 §6, no schema or revision
//! is frozen until the real-driver validation gate (Phase 4) passes. Draft
//! schemas may change together until then.

use serde::de::{
    self, DeserializeOwned, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;

/// Device protocol version proposed by this crate.
pub const DEVICE_PROTOCOL_VERSION: u32 = 1;
/// Binary frame header length in bytes (RFC 001 §2.3).
pub const FRAME_HEADER_LEN: usize = 12;
/// Frame header version for protocol v1.
pub const FRAME_VERSION: u8 = 1;
/// Lease renewal interval (RFC 001 §2.7), milliseconds.
pub const LEASE_RENEW_INTERVAL_MS: u64 = 5_000;
/// Lease expiry (RFC 001 §2.7), milliseconds.
pub const LEASE_EXPIRY_MS: u64 = 15_000;
/// Maximum bulk chunk handed to the transport per scheduling turn (§2.3).
/// Receivers treat a larger frame payload as a violation of the request.
pub const MAX_BULK_CHUNK_BYTES: usize = 64 * 1024;
/// Bulk enqueueing stops when transport-pending bytes reach this bound (§2.3).
pub const MAX_TRANSPORT_PENDING_BYTES: usize = 256 * 1024;
/// Largest JSON-safe integer (2^53 − 1): durations.
pub const JSON_SAFE_MAX: u64 = 9_007_199_254_740_991;
/// Reserved connection-owned control capability (§2.2).
pub const CORE_CAPABILITIES: &str = "core.capabilities";

/// String and array bounds shared by [`DeviceMessage::validate`],
/// [`validate_payload`] and the exported schemas. String bounds count
/// Unicode code points (JSON Schema `maxLength` semantics), never UTF-16
/// units or bytes.
pub mod limits {
    pub const CAPABILITY_NAME_MAX: usize = 128;
    pub const MODULE_INSTANCE_ID_MAX: usize = 256;
    pub const PLATFORM_DETAIL_MAX: usize = 512;
    pub const CONTENT_TYPE_MAX: usize = 256;
    pub const FILE_NAME_MAX: usize = 512;
    pub const ACCEPT_ENTRY_MAX: usize = 128;
    pub const ACCEPT_MAX_ITEMS: usize = 32;
    pub const BLUETOOTH_ID_MAX: usize = 128;
    pub const BLUETOOTH_NAME_MAX: usize = 256;
    pub const HELLO_PROTOCOL_VERSIONS_MAX: usize = 8;
    pub const CAPABILITIES_MAX: usize = 64;
    pub const OFFER_VERSIONS_MAX: usize = 32;
    pub const MIC_SAMPLE_RATE_MIN: u32 = 8_000;
    pub const MIC_SAMPLE_RATE_MAX: u32 = 192_000;
    /// `mic.record@1` optional `maxDurationMs` upper bound (a recording
    /// limit, not a size).
    pub const MIC_MAX_DURATION_MS: u64 = 600_000;
    /// `mic.record@1` optional `channels` (interleaved PCM16): 1 or 2.
    pub const MIC_CHANNELS_MAX: u8 = 2;
    /// `camera.capture@1` optional `maxDurationMs` upper bound (video only).
    pub const CAMERA_MAX_DURATION_MS: u64 = 600_000;
    /// `bluetooth.select@1` `services` filter: at most this many UUIDs.
    pub const BLUETOOTH_SERVICES_MAX: usize = 16;
    /// `bluetooth.select@1` `namePrefix` bound, code points.
    pub const BLUETOOTH_NAME_PREFIX_MAX: usize = 64;

    /// RFC 001 §2.1 JSON limits, identical in every SDK and applied to the
    /// whole device message (envelope and `params`/`result`/`event`) and to
    /// the handshake extension objects.
    ///
    /// Largest device text message, in UTF-8 bytes, checked before parsing.
    pub const MESSAGE_MAX_BYTES: usize = 1_048_576;
    /// Deepest container nesting (`{` or `[`); scalars do not count. The
    /// envelope object itself is depth 1.
    pub const JSON_MAX_DEPTH: usize = 32;
    /// Largest integer magnitude (2^53 − 1). Integer tokens only; field
    /// schemas are tighter.
    pub const JSON_INTEGER_MAX: u64 = super::JSON_SAFE_MAX;
}

/// Length in Unicode code points (JSON Schema `maxLength`/`minLength`).
fn code_points(s: &str) -> usize {
    s.chars().count()
}

fn check_len(s: &str, min: usize, max: usize, err: &'static str) -> Result<(), &'static str> {
    let n = code_points(s);
    if n < min || n > max {
        Err(err)
    } else {
        Ok(())
    }
}

fn all_unique<T: Eq + std::hash::Hash>(items: impl IntoIterator<Item = T>) -> bool {
    let mut seen = HashSet::new();
    items.into_iter().all(|x| seen.insert(x))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(is_lower_hex)
}

fn is_lower_hex(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f')
}

/// Canonical Bluetooth UUID spelling on the wire: the lowercase 128-bit
/// form `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` ([`BLUETOOTH_UUID_PATTERN`]).
/// A 16-bit SIG short id `0x180d` is sent expanded against the Bluetooth
/// base UUID: `0000180d-0000-1000-8000-00805f9b34fb`.
pub fn is_bluetooth_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => is_lower_hex(c),
        })
}

/// JSON Schema `pattern` for [`is_bluetooth_uuid`].
pub const BLUETOOTH_UUID_PATTERN: &str =
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

// ---------------------------------------------------------------------------
// Strict decoding helpers
// ---------------------------------------------------------------------------

/// A JSON value decoded with duplicate-key rejection at every depth.
/// (`serde_json::Value` keeps the last duplicate silently.)
struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::Bool(v)))
    }
    fn visit_i64<E>(self, v: i64) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::from(v)))
    }
    fn visit_u64<E>(self, v: u64) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::from(v)))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<StrictValue, E> {
        serde_json::Number::from_f64(v)
            .map(|n| StrictValue(Value::Number(n)))
            .ok_or_else(|| E::custom("non-finite number"))
    }
    fn visit_str<E>(self, v: &str) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::String(v.to_owned())))
    }
    fn visit_string<E>(self, v: String) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::String(v)))
    }
    fn visit_unit<E>(self) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::Null))
    }
    fn visit_none<E>(self) -> Result<StrictValue, E> {
        Ok(StrictValue(Value::Null))
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<StrictValue, D::Error> {
        StrictValue::deserialize(d)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<StrictValue, A::Error> {
        let mut out = Vec::new();
        while let Some(StrictValue(v)) = seq.next_element()? {
            out.push(v);
        }
        Ok(StrictValue(Value::Array(out)))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<StrictValue, A::Error> {
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom(format_args!("duplicate key `{key}`")));
            }
            let StrictValue(v) = map.next_value()?;
            out.insert(key, v);
        }
        Ok(StrictValue(Value::Object(out)))
    }
}

// ---------------------------------------------------------------------------
// RFC 001 §2.1 JSON limits (one set, every SDK)
// ---------------------------------------------------------------------------

/// Parser seed carrying the nesting depth of the enclosing container.
struct LimitedSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for LimitedSeed {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(LimitedVisitor { depth: self.depth })
    }
}

struct LimitedVisitor {
    depth: usize,
}

impl LimitedVisitor {
    fn enter<E: de::Error>(&self) -> Result<usize, E> {
        let depth = self.depth + 1;
        if depth > limits::JSON_MAX_DEPTH {
            return Err(E::custom("nesting deeper than 32 containers"));
        }
        Ok(depth)
    }
}

impl<'de> Visitor<'de> for LimitedVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value within the device-message limits")
    }
    fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        if v.unsigned_abs() > limits::JSON_INTEGER_MAX {
            return Err(E::custom("integer magnitude above 2^53 - 1"));
        }
        Ok(Value::from(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        if v > limits::JSON_INTEGER_MAX {
            return Err(E::custom("integer magnitude above 2^53 - 1"));
        }
        Ok(Value::from(v))
    }
    /// serde_json reports every fraction, exponent, `-0` and integer beyond
    /// 64 bits as a float: none of them is an integer token.
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Value, E> {
        Err(E::custom(
            "numbers are integer tokens: no fraction, exponent or -0",
        ))
    }
    fn visit_str<E>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let depth = self.enter()?;
        let mut out = Vec::new();
        while let Some(v) = seq.next_element_seed(LimitedSeed { depth })? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let depth = self.enter()?;
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            // Compared after unescaping: `"id"` and `"\u0069d"` collide.
            if out.contains_key(&key) {
                return Err(de::Error::custom(format_args!("duplicate key `{key}`")));
            }
            let v = map.next_value_seed(LimitedSeed { depth })?;
            out.insert(key, v);
        }
        Ok(Value::Object(out))
    }
}

/// Parse device JSON text under the RFC 001 §2.1 limits: size (checked
/// before parsing), depth, integer-only numbers within ±(2^53 − 1),
/// duplicate keys at any depth. serde_json itself rejects invalid escapes,
/// lone surrogate escapes, raw control characters (< 0x20) in keys and
/// values, bare tokens other than `true`/`false`/`null`, and trailing data.
pub fn parse_strict_json(text: &str) -> Result<Value, WireError> {
    if text.len() > limits::MESSAGE_MAX_BYTES {
        return Err(WireError::Invalid("device message larger than 1 MiB"));
    }
    let mut de = serde_json::Deserializer::from_str(text);
    let value = LimitedSeed { depth: 0 }
        .deserialize(&mut de)
        .map_err(WireError::Decode)?;
    de.end().map_err(WireError::Decode)?;
    Ok(value)
}

/// [`parse_strict_json`] for raw bytes: rejects invalid UTF-8 first.
pub fn parse_strict_json_bytes(bytes: &[u8]) -> Result<Value, WireError> {
    if bytes.len() > limits::MESSAGE_MAX_BYTES {
        return Err(WireError::Invalid("device message larger than 1 MiB"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| WireError::Invalid("not valid UTF-8"))?;
    parse_strict_json(text)
}

/// The value-level half of the JSON limits, for values that did not come
/// from [`parse_strict_json`]: depth, integer-only numbers, magnitude.
pub fn check_json_value(v: &Value) -> Result<(), &'static str> {
    check_json_value_at(v).map_err(|(_, rule)| rule)
}

/// One step of a JSON path (borrowed while walking; formatted only on error).
#[derive(Debug, Clone, Copy)]
enum PathSeg<'a> {
    Key(&'a str),
    Index(usize),
}

/// A JSONPath-style location (`$.items[1].sha256`, `$["odd key"]`) for
/// payload diagnostics. Keys are bounded so a hostile key cannot bloat a
/// refusal detail.
fn format_path<'a>(segs: impl IntoIterator<Item = PathSeg<'a>>) -> String {
    let mut out = String::from("$");
    for seg in segs {
        match seg {
            PathSeg::Index(i) => out.push_str(&format!("[{i}]")),
            PathSeg::Key(k) => {
                let plain = !k.is_empty()
                    && k.chars().count() <= 64
                    && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && !k.starts_with(|c: char| c.is_ascii_digit());
                if plain {
                    out.push('.');
                    out.push_str(k);
                } else {
                    let short: String = k.chars().take(64).collect();
                    let quoted = serde_json::to_string(&short).unwrap_or_default();
                    out.push('[');
                    out.push_str(&quoted);
                    if short.len() < k.len() {
                        out.push('…');
                    }
                    out.push(']');
                }
            }
        }
    }
    out
}

/// [`check_json_value`] that also reports WHERE the value breaks a limit.
fn check_json_value_at(v: &Value) -> Result<(), (String, &'static str)> {
    fn walk<'a>(
        v: &'a Value,
        depth: usize,
        path: &mut Vec<PathSeg<'a>>,
    ) -> Result<(), &'static str> {
        match v {
            Value::Array(items) => {
                let depth = depth + 1;
                if depth > limits::JSON_MAX_DEPTH {
                    return Err("nesting deeper than 32 containers");
                }
                for (i, item) in items.iter().enumerate() {
                    path.push(PathSeg::Index(i));
                    walk(item, depth, path)?;
                    path.pop();
                }
                Ok(())
            }
            Value::Object(map) => {
                let depth = depth + 1;
                if depth > limits::JSON_MAX_DEPTH {
                    return Err("nesting deeper than 32 containers");
                }
                for (k, item) in map {
                    path.push(PathSeg::Key(k));
                    walk(item, depth, path)?;
                    path.pop();
                }
                Ok(())
            }
            Value::Number(n) => {
                let ok = match (n.as_u64(), n.as_i64()) {
                    (Some(u), _) => u <= limits::JSON_INTEGER_MAX,
                    (None, Some(i)) => i.unsigned_abs() <= limits::JSON_INTEGER_MAX,
                    (None, None) => false, // a float: not an integer token
                };
                if ok {
                    Ok(())
                } else {
                    Err("numbers are integers within 2^53 - 1")
                }
            }
            Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        }
    }
    let mut path = Vec::new();
    walk(v, 0, &mut path).map_err(|rule| (format_path(path), rule))
}

/// [`check_json_value_at`] as a payload refusal (`<path>: <rule>`).
fn check_payload_json(v: &Value) -> Result<(), String> {
    check_json_value_at(v).map_err(|(path, rule)| format!("{path}: {rule}"))
}

/// Where two JSON values first differ (the decoded-and-re-encoded payload
/// against its input): used to locate a non-canonical encoding.
fn first_difference<'a>(a: &'a Value, b: &Value, path: &mut Vec<PathSeg<'a>>) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, va) in x {
                path.push(PathSeg::Key(k));
                match y.get(k) {
                    Some(vb) => {
                        if first_difference(va, vb, path) {
                            return true;
                        }
                    }
                    None => return true,
                }
                path.pop();
            }
            x.len() != y.len()
        }
        (Value::Array(x), Value::Array(y)) => {
            for (i, (va, vb)) in x.iter().zip(y).enumerate() {
                path.push(PathSeg::Index(i));
                if first_difference(va, vb, path) {
                    return true;
                }
                path.pop();
            }
            x.len() != y.len()
        }
        _ => a != b,
    }
}

/// Bound a refusal detail (serde messages echo attacker-controlled values).
fn bounded(detail: String) -> String {
    const MAX: usize = 300;
    if detail.chars().count() <= MAX {
        detail
    } else {
        let mut out: String = detail.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

/// A payload refusal: `<JSON path>: <rule>`.
fn refuse(path: &str, rule: impl fmt::Display) -> String {
    format!("{path}: {rule}")
}

/// A string bound in code points (JSON Schema `minLength`/`maxLength`), as
/// a payload refusal naming the field.
fn check_len_at(path: &str, s: &str, min: usize, max: usize) -> Result<(), String> {
    let n = code_points(s);
    if n > max {
        Err(refuse(path, format!("longer than {max} code points ({n})")))
    } else if n < min {
        Err(refuse(
            path,
            format!("shorter than {min} code points ({n})"),
        ))
    } else {
        Ok(())
    }
}

/// Strict typed decoding of a value already within the JSON limits: closed
/// serde decoding, then canonical round-trip (re-serializing must give back
/// the input exactly — no array for an object, no one-key map for an enum).
fn strict_typed<T: DeserializeOwned + Serialize>(v: &Value) -> Result<T, WireError> {
    let t = T::deserialize(v).map_err(WireError::Decode)?;
    let back = serde_json::to_value(&t).map_err(WireError::Decode)?;
    if back != *v {
        return Err(WireError::Invalid(
            "non-canonical encoding (array for an object or map for an enum)",
        ));
    }
    Ok(t)
}

/// A required member that must be a JSON object (duplicate keys rejected).
fn de_object<'de, D: Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
    let StrictValue(v) = StrictValue::deserialize(d)?;
    if v.is_object() {
        Ok(v)
    } else {
        Err(de::Error::custom("expected a JSON object"))
    }
}

/// An optional member that, when present, must be a JSON object (`null` is
/// not absence).
fn de_present_object<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    de_object(d).map(Some)
}

/// An optional member that, when present, must hold a `T` (`null` rejected).
fn de_present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// `simulated` is `const true` when present.
fn de_simulated<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    if bool::deserialize(d)? {
        Ok(true)
    } else {
        Err(de::Error::custom("simulated must be true when present"))
    }
}

fn next_once<'de, A: MapAccess<'de>, T: Deserialize<'de>>(
    map: &mut A,
    slot: &mut Option<T>,
    key: &'static str,
) -> Result<(), A::Error> {
    if slot.is_some() {
        return Err(de::Error::duplicate_field(key));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/// A decode or validation failure for one device message.
#[derive(Debug)]
pub enum WireError {
    /// JSON text is not a well-formed device message (grammar, JSON limits,
    /// closed typed decoding).
    Decode(serde_json::Error),
    /// A size/encoding limit, a canonical-encoding failure, or well-formed
    /// JSON violating a protocol-level rule or bound.
    Invalid(&'static str),
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::Decode(e) => write!(f, "decode: {e}"),
            WireError::Invalid(e) => write!(f, "invalid: {e}"),
        }
    }
}

impl std::error::Error for WireError {}

/// The three device envelope messages (RFC 001 §2.1).
///
/// Rides the same JSON channel as [`super::RemoteMessage`] but is routed
/// through a dedicated device plane in every SDK: this union must never be
/// assignable to the UI `OutgoingMessage` union (no `broadcast()` carriage).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DeviceMessage {
    DeviceRequest(DeviceRequest),
    DeviceResponse(DeviceResponse),
    DeviceEvent(DeviceEvent),
}

impl DeviceMessage {
    /// Strict decode of one text-channel device message: serde strictness
    /// (closed objects, exact-case keys, no duplicate keys, no `null`s for
    /// typed members) followed by [`Self::validate`]. Decode from the JSON
    /// **text**: a `serde_json::Value` has already collapsed duplicate keys.
    pub fn decode(text: &str) -> Result<DeviceMessage, WireError> {
        Self::decode_value(&parse_strict_json(text)?)
    }

    /// [`Self::decode`] for raw WebSocket text-frame bytes: invalid UTF-8 is
    /// rejected before anything else.
    pub fn decode_bytes(bytes: &[u8]) -> Result<DeviceMessage, WireError> {
        Self::decode_value(&parse_strict_json_bytes(bytes)?)
    }

    /// Strict decode of an already-parsed value: the value-level JSON limits
    /// ([`check_json_value`]), closed typed decoding, canonical round-trip,
    /// then [`Self::validate`]. A value parsed with `serde_json::Value` has
    /// already collapsed duplicate keys; prefer [`Self::decode`].
    pub fn decode_value(value: &Value) -> Result<DeviceMessage, WireError> {
        check_json_value(value).map_err(WireError::Invalid)?;
        let msg: DeviceMessage = strict_typed(value)?;
        msg.validate().map_err(WireError::Invalid)?;
        Ok(msg)
    }

    /// Every envelope-level rule: bounds, XORs, control/owner strictness,
    /// owner/lifetime agreement. Capability payloads are checked separately
    /// against the selected revision with [`validate_payload`].
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            DeviceMessage::DeviceRequest(r) => r.validate(),
            DeviceMessage::DeviceResponse(r) => r.validate(),
            DeviceMessage::DeviceEvent(e) => e.validate(),
        }
    }

    pub fn id(&self) -> u32 {
        match self {
            DeviceMessage::DeviceRequest(r) => r.id,
            DeviceMessage::DeviceResponse(r) => r.id,
            DeviceMessage::DeviceEvent(e) => e.id,
        }
    }
}

/// The three device message types, by their `type` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    Request,
    Response,
    Event,
}

/// Violation attribution for a message that failed strict decoding
/// (RFC 001 §2.1, decisions D3/D8). `value` must already be within the JSON
/// limits ([`parse_strict_json`] succeeded — text failing the limits is
/// attributable to no request). Returns the message type and id when `type`
/// is one of the three device types and `id` is an integer in 1..=u32::MAX:
/// a *known-id invalid message* when that id is live for the receiver (the
/// detecting client sends a terminal `invalidParams`, the detecting server
/// sends `cancel` and settles locally), ignored when it is not. `None` is a
/// connection-level violation: discarded and counted, never attributed.
pub fn attribute_invalid(value: &Value) -> Option<(MessageKind, u32)> {
    let obj = value.as_object()?;
    let kind = match obj.get("type")?.as_str()? {
        "deviceRequest" => MessageKind::Request,
        "deviceResponse" => MessageKind::Response,
        "deviceEvent" => MessageKind::Event,
        _ => return None,
    };
    let id = u32::try_from(obj.get("id")?.as_u64()?).ok()?;
    (id != 0).then_some((kind, id))
}

/// Server → client: open a module-owned operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRequest {
    /// Monotonically increasing, never reused on a connection. Zero reserved.
    pub id: u32,
    /// Capability name from the negotiated intersection.
    pub capability: String,
    /// Exact revision selected for this request's full lifetime.
    pub version: u32,
    /// Logical owner; shape must match `lifetime`.
    pub owner: Owner,
    /// Requested lifetime; must be allowed by the capability revision.
    pub lifetime: Lifetime,
    /// Overall deadline upper bound the server requests. Positive, bounded by
    /// the largest registry `max_timeout_ms` (and per revision by its own).
    pub timeout_ms: u64,
    /// Initial data credit. MUST be zero for server→client data directions.
    pub initial_credit: u64,
    /// Capability-defined parameters (validated against the selected revision).
    #[serde(deserialize_with = "de_object")]
    pub params: Value,
}

impl DeviceRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id == 0 {
            return Err("id 0 is reserved");
        }
        check_len(
            &self.capability,
            1,
            limits::CAPABILITY_NAME_MAX,
            "capability name length out of bounds",
        )?;
        if self.version == 0 {
            return Err("version 0 is reserved");
        }
        self.owner.validate()?;
        if !self.owner.matches(self.lifetime) {
            return Err("owner shape does not match lifetime");
        }
        if self.timeout_ms == 0 || self.timeout_ms > registry_max_timeout_ms() {
            return Err("timeoutMs out of bounds");
        }
        if self.initial_credit > registry_max_initial_credit() {
            return Err("initialCredit out of bounds");
        }
        if !self.params.is_object() {
            return Err("params must be an object");
        }
        Ok(())
    }
}

/// Client → server: the single terminal message for a request.
///
/// Exactly one of `result` / `error` is present — the XOR is checked by
/// [`Self::validate`]; strict decoding already rejects `null` for either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceResponse {
    pub id: u32,
    #[serde(
        default,
        deserialize_with = "de_present_object",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(
        default,
        deserialize_with = "de_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<DeviceError>,
    /// True when produced by a fake/simulated host. Protocol-level, shared by
    /// every capability; never omitted by fakes. `const true` on the wire:
    /// `false` is expressed by absence, and an explicit `false` is rejected.
    #[serde(
        default,
        deserialize_with = "de_simulated",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub simulated: bool,
}

impl DeviceResponse {
    /// Terminal XOR rule (result or error, never both, never neither), plus
    /// id and member bounds.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id == 0 {
            return Err("id 0 is reserved");
        }
        match (&self.result, &self.error) {
            (Some(r), None) => {
                if !r.is_object() {
                    return Err("result must be an object");
                }
            }
            (None, Some(e)) => e.validate()?,
            (Some(_), Some(_)) => return Err("deviceResponse carries both result and error"),
            (None, None) => return Err("deviceResponse carries neither result nor error"),
        }
        Ok(())
    }
}

/// Either direction: capability-defined events or exactly one control variant.
///
/// `event` and `control` are mutually exclusive — enforce with [`Self::validate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceEvent {
    pub id: u32,
    #[serde(
        default,
        deserialize_with = "de_present_object",
        skip_serializing_if = "Option::is_none"
    )]
    pub event: Option<Value>,
    #[serde(
        default,
        deserialize_with = "de_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub control: Option<Control>,
}

impl DeviceEvent {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id == 0 {
            return Err("id 0 is reserved");
        }
        match (&self.event, &self.control) {
            (Some(e), None) => {
                if !e.is_object() {
                    return Err("event must be an object");
                }
            }
            (None, Some(c)) => c.validate()?,
            (Some(_), Some(_)) => return Err("deviceEvent carries both event and control"),
            (None, None) => return Err("deviceEvent carries neither event nor control"),
        }
        Ok(())
    }
}

/// Control variants (RFC 001 §2.1/§2.7). Exactly one key per control.
///
/// Decoding is strict (hand-written, not `untagged`): exactly one known,
/// exact-case key; no `null` sibling; `cancel` is `const true`; `grant` is
/// positive and bounded by the largest registry `max_outstanding_credit`;
/// lease sequences are positive u32s (like ids and frame `seq`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Control {
    /// Receiver → sender: additive credit for the request's data budget.
    Grant { grant: u64 },
    /// Server → client: retire the id immediately; races settle locally.
    /// Always `true` on the wire.
    Cancel { cancel: bool },
    /// Server → client: lease renewal, increasing sequence from 1.
    #[serde(rename_all = "camelCase")]
    RenewLease { renew_lease: u32 },
    /// Client → server: acknowledges the exact lease sequence.
    #[serde(rename_all = "camelCase")]
    LeaseAck { lease_ack: u32 },
    /// Data sender → receiver: backpressure transition report.
    Paused { paused: bool },
}

const CONTROL_KEYS: &[&str] = &["grant", "cancel", "renewLease", "leaseAck", "paused"];

impl Control {
    pub fn validate(&self) -> Result<(), &'static str> {
        match *self {
            Control::Grant { grant } => {
                if grant == 0 || grant > registry_max_outstanding_credit() {
                    return Err("grant out of bounds");
                }
            }
            Control::Cancel { cancel } => {
                if !cancel {
                    return Err("cancel must be true");
                }
            }
            Control::RenewLease { renew_lease: n } | Control::LeaseAck { lease_ack: n } => {
                if n == 0 {
                    return Err("lease sequence 0 is reserved");
                }
            }
            Control::Paused { .. } => {}
        }
        Ok(())
    }

    /// Strict check on a raw JSON control value (same rules as decoding).
    pub fn validate_value(v: &Value) -> Result<(), &'static str> {
        let text = serde_json::to_string(v).map_err(|_| "control is not JSON")?;
        serde_json::from_str::<Control>(&text)
            .map(|_| ())
            .map_err(|_| "control must be exactly one valid variant")
    }
}

impl<'de> Deserialize<'de> for Control {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Control;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a control object with exactly one variant")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Control, A::Error> {
                let Some(key) = map.next_key::<String>()? else {
                    return Err(de::Error::custom(
                        "control must contain exactly one variant",
                    ));
                };
                let control = match key.as_str() {
                    "grant" => Control::Grant {
                        grant: map.next_value()?,
                    },
                    "cancel" => Control::Cancel {
                        cancel: map.next_value()?,
                    },
                    "renewLease" => Control::RenewLease {
                        renew_lease: map.next_value()?,
                    },
                    "leaseAck" => Control::LeaseAck {
                        lease_ack: map.next_value()?,
                    },
                    "paused" => Control::Paused {
                        paused: map.next_value()?,
                    },
                    other => return Err(de::Error::unknown_field(other, CONTROL_KEYS)),
                };
                if map.next_key::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom(
                        "control must contain exactly one variant",
                    ));
                }
                control.validate().map_err(de::Error::custom)?;
                Ok(control)
            }
        }
        d.deserialize_map(V)
    }
}

// ---------------------------------------------------------------------------
// Owner and lifetime
// ---------------------------------------------------------------------------

/// Requested lifetime for a device operation (RFC 001 §2.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lifetime {
    /// Owned by an exact `{moduleInstanceId, activationId}`; swept on deactivation.
    Activation,
    /// Owned by `{moduleInstanceId}`; swept on destruction, not deactivation.
    Background,
    /// Reserved for protocol control (`core.*`); survives module navigation.
    Connection,
}

/// Logical owner identity travelling with the request.
///
/// Decoding is strict and exact: `{moduleInstanceId, activationId}`,
/// `{moduleInstanceId}` or `{connection: true}` with no other key. A
/// malformed activation owner is rejected, never downgraded to a module
/// owner. `moduleInstanceId` is 1–256 code points; `activationId` ≥ 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Owner {
    #[serde(rename_all = "camelCase")]
    Activation {
        module_instance_id: String,
        activation_id: u32,
    },
    #[serde(rename_all = "camelCase")]
    Module { module_instance_id: String },
    /// Always `true` on the wire.
    Connection { connection: bool },
}

const OWNER_KEYS: &[&str] = &["moduleInstanceId", "activationId", "connection"];

impl Owner {
    /// Owner shape must match the requested lifetime (RFC 001 §2.7).
    pub fn matches(&self, lifetime: Lifetime) -> bool {
        matches!(
            (self, lifetime),
            (Owner::Activation { .. }, Lifetime::Activation)
                | (Owner::Module { .. }, Lifetime::Background)
                | (Owner::Connection { connection: true }, Lifetime::Connection)
        )
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Owner::Activation {
                module_instance_id,
                activation_id,
            } => {
                check_len(
                    module_instance_id,
                    1,
                    limits::MODULE_INSTANCE_ID_MAX,
                    "moduleInstanceId length out of bounds",
                )?;
                if *activation_id == 0 {
                    return Err("activationId must be >= 1");
                }
            }
            Owner::Module { module_instance_id } => check_len(
                module_instance_id,
                1,
                limits::MODULE_INSTANCE_ID_MAX,
                "moduleInstanceId length out of bounds",
            )?,
            Owner::Connection { connection } => {
                if !connection {
                    return Err("connection must be true");
                }
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for Owner {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Owner;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an owner object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Owner, A::Error> {
                let mut module_instance_id: Option<String> = None;
                let mut activation_id: Option<u32> = None;
                let mut connection: Option<bool> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "moduleInstanceId" => {
                            next_once(&mut map, &mut module_instance_id, "moduleInstanceId")?
                        }
                        "activationId" => next_once(&mut map, &mut activation_id, "activationId")?,
                        "connection" => next_once(&mut map, &mut connection, "connection")?,
                        other => return Err(de::Error::unknown_field(other, OWNER_KEYS)),
                    }
                }
                let owner = match (module_instance_id, activation_id, connection) {
                    (Some(module_instance_id), Some(activation_id), None) => Owner::Activation {
                        module_instance_id,
                        activation_id,
                    },
                    (Some(module_instance_id), None, None) => Owner::Module { module_instance_id },
                    (None, None, Some(connection)) => Owner::Connection { connection },
                    _ => {
                        return Err(de::Error::custom(
                            "owner must be exactly {moduleInstanceId, activationId}, \
                             {moduleInstanceId} or {connection: true}",
                        ))
                    }
                };
                owner.validate().map_err(de::Error::custom)?;
                Ok(owner)
            }
        }
        d.deserialize_map(V)
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Closed error taxonomy for protocol v1 (RFC 001 §3). New codes after
/// stabilization require a negotiated protocol version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceErrorCode {
    Unsupported,
    Unavailable,
    Denied,
    Revoked,
    Cancelled,
    Timeout,
    Throttled,
    ConnectionLost,
    InvalidParams,
    Internal,
}

impl DeviceErrorCode {
    /// Every code, for exhaustiveness fixtures and schema generation.
    pub const ALL: [DeviceErrorCode; 10] = [
        DeviceErrorCode::Unsupported,
        DeviceErrorCode::Unavailable,
        DeviceErrorCode::Denied,
        DeviceErrorCode::Revoked,
        DeviceErrorCode::Cancelled,
        DeviceErrorCode::Timeout,
        DeviceErrorCode::Throttled,
        DeviceErrorCode::ConnectionLost,
        DeviceErrorCode::InvalidParams,
        DeviceErrorCode::Internal,
    ];
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceError {
    pub code: DeviceErrorCode,
    /// Bounded diagnostic text (≤ 512 code points; `""` is present, `null`
    /// is rejected). Portable handlers MUST NOT branch on it.
    #[serde(
        default,
        deserialize_with = "de_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub platform_detail: Option<String>,
}

impl DeviceError {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(detail) = &self.platform_detail {
            check_len(
                detail,
                0,
                limits::PLATFORM_DETAIL_MAX,
                "platformDetail too long",
            )?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Handshake extension and revision selection
// ---------------------------------------------------------------------------

/// A capability offer: name plus every implementable revision (client side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityOffer {
    pub name: String,
    pub versions: Vec<u32>,
}

impl CapabilityOffer {
    pub fn validate(&self) -> Result<(), &'static str> {
        check_len(
            &self.name,
            1,
            limits::CAPABILITY_NAME_MAX,
            "capability name length out of bounds",
        )?;
        if self.versions.len() > limits::OFFER_VERSIONS_MAX {
            return Err("too many versions in capability offer");
        }
        if self.versions.contains(&0) {
            return Err("version 0 is reserved");
        }
        if !all_unique(&self.versions) {
            return Err("duplicate version in capability offer");
        }
        Ok(())
    }
}

/// Names compare by exact code points (bytes), never by Unicode canonical
/// equivalence: `"\u{e9}"` and `"e\u{301}"` are distinct names.
fn validate_offers(offers: &[CapabilityOffer]) -> Result<(), &'static str> {
    if offers.len() > limits::CAPABILITIES_MAX {
        return Err("too many capabilities");
    }
    for offer in offers {
        offer.validate()?;
    }
    if !all_unique(offers.iter().map(|o| o.name.as_str())) {
        return Err("duplicate capability name");
    }
    Ok(())
}

/// A selected capability revision (server side of the handshake).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySelection {
    pub name: String,
    pub version: u32,
}

/// `hello.device` — the client's complete initial advertisement (§2.2).
/// Bootstrap schema: fixed; incompatible changes need a separate extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceHello {
    pub protocol_versions: Vec<u32>,
    pub binary: bool,
    pub capabilities: Vec<CapabilityOffer>,
}

impl DeviceHello {
    /// Strict decode of `hello.device` JSON text (JSON limits, closed typed
    /// decoding, canonical round-trip, [`Self::validate`]). A failure
    /// disables device access for the connection (RFC 001 §2.2).
    pub fn decode(text: &str) -> Result<DeviceHello, WireError> {
        Self::from_value(&parse_strict_json(text)?)
    }

    /// [`Self::decode`] for an already-parsed value.
    pub fn from_value(value: &Value) -> Result<DeviceHello, WireError> {
        check_json_value(value).map_err(WireError::Invalid)?;
        let hello: DeviceHello = strict_typed(value)?;
        hello.validate().map_err(WireError::Invalid)?;
        Ok(hello)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_versions.len() > limits::HELLO_PROTOCOL_VERSIONS_MAX {
            return Err("too many protocol versions");
        }
        if self.protocol_versions.contains(&0) {
            return Err("protocol version 0 is reserved");
        }
        if !all_unique(&self.protocol_versions) {
            return Err("duplicate protocol version");
        }
        validate_offers(&self.capabilities)
    }
}

/// `sessionAck.device` — the server's selection (§2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceAck {
    pub protocol_version: u32,
    pub binary: bool,
    pub capabilities: Vec<CapabilitySelection>,
}

impl DeviceAck {
    /// Strict decode of `sessionAck.device` JSON text. A client that cannot
    /// decode the ack keeps device access disabled.
    pub fn decode(text: &str) -> Result<DeviceAck, WireError> {
        Self::from_value(&parse_strict_json(text)?)
    }

    /// [`Self::decode`] for an already-parsed value.
    pub fn from_value(value: &Value) -> Result<DeviceAck, WireError> {
        check_json_value(value).map_err(WireError::Invalid)?;
        let ack: DeviceAck = strict_typed(value)?;
        ack.validate().map_err(WireError::Invalid)?;
        Ok(ack)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version == 0 {
            return Err("protocol version 0 is reserved");
        }
        if self.capabilities.len() > limits::CAPABILITIES_MAX {
            return Err("too many capabilities");
        }
        for sel in &self.capabilities {
            check_len(
                &sel.name,
                1,
                limits::CAPABILITY_NAME_MAX,
                "capability name length out of bounds",
            )?;
            if sel.version == 0 {
                return Err("version 0 is reserved");
            }
        }
        if !all_unique(self.capabilities.iter().map(|c| c.name.as_str())) {
            return Err("duplicate capability name");
        }
        Ok(())
    }
}

/// `core.capabilities` stream event: a complete replacement advertisement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesEvent {
    pub capabilities: Vec<CapabilityOffer>,
}

impl CapabilitiesEvent {
    /// Strict decode of a `core.capabilities` snapshot event body.
    pub fn decode(text: &str) -> Result<CapabilitiesEvent, WireError> {
        Self::from_value(&parse_strict_json(text)?)
    }

    /// [`Self::decode`] for an already-parsed value.
    pub fn from_value(value: &Value) -> Result<CapabilitiesEvent, WireError> {
        check_json_value(value).map_err(WireError::Invalid)?;
        let ev: CapabilitiesEvent = strict_typed(value)?;
        ev.validate().map_err(WireError::Invalid)?;
        Ok(ev)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        validate_offers(&self.capabilities)
    }
}

/// Reference selection algorithm (§2.2). Every SDK broker mirrors this exact
/// function; `fixtures/device/conformance/selection.json` pins it.
///
/// - The hello is validated first ([`DeviceHello::validate`], i.e. the
///   handshake-v1 schema plus unique names): an invalid `hello.device`
///   disables device access (`None`). This covers rule (d): a hello whose
///   `capabilities` repeat a name, or whose `protocolVersions`/`versions`
///   repeat a value or contain the reserved 0, never gets an ack — the server
///   never picks among conflicting offers.
/// - (a) Version 0 is reserved and never selected (protocol or revision),
///   also when the server's own lists contain it.
/// - Highest mutually supported protocol version; none → `None` (device
///   access disabled, UI-only operation continues).
/// - Per capability, the highest mutually supported revision that this
///   endpoint's [`registry()`] declares (the server has no schema for any
///   other revision, so it can never select one).
/// - (c) When the negotiated `binary` is false, a revision whose data plane
///   is [`DataPlane::BinaryUpload`]/[`DataPlane::BinaryDownload`] is not
///   selectable: the highest mutually supported revision that works without
///   binary is chosen instead, else the capability is omitted.
/// - (b) `core.capabilities` revision 1 must be in the intersection;
///   otherwise device access is disabled (`None`).
/// - (e) Duplicate server-side names: the first occurrence wins and later
///   ones are ignored (every SDK does the same; never merged).
/// - Names compare by exact code points, never canonical equivalence.
///
/// The ack lists capabilities in server order.
pub fn select_device_ack(
    hello: &DeviceHello,
    server_protocol_versions: &[u32],
    server_capabilities: &[CapabilityOffer],
    server_binary: bool,
) -> Option<DeviceAck> {
    // Validate the hello first: schema-invalid or conflicting → disabled.
    if hello.validate().is_err() {
        return None;
    }

    // (a) + highest common protocol version.
    let protocol_version = hello
        .protocol_versions
        .iter()
        .copied()
        .filter(|&v| v != 0 && server_protocol_versions.contains(&v))
        .max()?;
    let binary = hello.binary && server_binary;

    let mut capabilities = Vec::new();
    let mut server_names = HashSet::new();
    let mut core_v1_mutual = false;
    for server_cap in server_capabilities {
        // (e) duplicate server entries: the first occurrence wins.
        if !server_names.insert(server_cap.name.as_str()) {
            continue;
        }
        let Some(client_cap) = hello
            .capabilities
            .iter()
            .find(|c| c.name == server_cap.name)
        else {
            continue;
        };
        let mutual = |v: u32| {
            v != 0
                && client_cap.versions.contains(&v)
                && find_revision(&server_cap.name, v).is_some()
        };
        if server_cap.name == CORE_CAPABILITIES && server_cap.versions.contains(&1) && mutual(1) {
            core_v1_mutual = true;
        }
        let best = server_cap
            .versions
            .iter()
            .copied()
            .filter(|&v| mutual(v))
            .filter(|&v| {
                // (c) binary-plane revisions need the binary profile.
                binary
                    || find_revision(&server_cap.name, v)
                        .map(|rev| !rev.data.is_binary())
                        .unwrap_or(false)
            })
            .max();
        if let Some(version) = best {
            capabilities.push(CapabilitySelection {
                name: server_cap.name.clone(),
                version,
            });
        }
    }

    // (b) mandatory control stream.
    if !core_v1_mutual {
        return None;
    }

    Some(DeviceAck {
        protocol_version,
        binary,
        capabilities,
    })
}

// ---------------------------------------------------------------------------
// Binary frame header (reference codec for golden-byte fixtures)
// ---------------------------------------------------------------------------

/// Fixed little-endian frame header (§2.3):
/// `[u8 version][u8 flags][u16 channel][u32 requestId][u32 seq]` (12 bytes).
///
/// `seq` is a u32 on every SDK: a sender terminates the request before it
/// would wrap past `u32::MAX`, and a receiver treats a wrap/decrease as a
/// violation. The codec is stateless: sequence, channel, direction, credit,
/// chunk-size and empty-payload rules are per-request receiver checks (see
/// the transcript runner), not decode errors. A frame with a zero-length
/// payload decodes here but is always a receiver-side `blob` violation on a
/// live id (it cannot carry data; a zero-byte item sends no frames).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub version: u8,
    pub flags: u8,
    pub channel: u16,
    pub request_id: u32,
    pub seq: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Frame shorter than the 12-byte header: dropped without effect.
    ShortHeader,
    /// Unknown version or nonzero flags: a **connection-level** protocol
    /// violation (transcript category `malformed`). The frame is discarded
    /// and counted (rate-limited diagnostics); an endpoint MAY close the
    /// connection after repeated violations. The header is untrusted, so it
    /// never terminates the request its `requestId` names.
    Violation,
}

impl FrameHeader {
    /// Encode the header bytes. Performs no validation: callers encode only
    /// `version = 1`, `flags = 0` headers.
    pub fn encode(&self) -> [u8; FRAME_HEADER_LEN] {
        let mut out = [0u8; FRAME_HEADER_LEN];
        out[0] = self.version;
        out[1] = self.flags;
        out[2..4].copy_from_slice(&self.channel.to_le_bytes());
        out[4..8].copy_from_slice(&self.request_id.to_le_bytes());
        out[8..12].copy_from_slice(&self.seq.to_le_bytes());
        out
    }

    /// Decode and validate per §2.3: short frames are dropped
    /// ([`FrameError::ShortHeader`]); unknown versions and nonzero flags are
    /// connection-level violations ([`FrameError::Violation`]). Returns the
    /// header and the payload slice.
    pub fn decode(frame: &[u8]) -> Result<(FrameHeader, &[u8]), FrameError> {
        if frame.len() < FRAME_HEADER_LEN {
            return Err(FrameError::ShortHeader);
        }
        let header = FrameHeader {
            version: frame[0],
            flags: frame[1],
            channel: u16::from_le_bytes([frame[2], frame[3]]),
            request_id: u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]),
            seq: u32::from_le_bytes([frame[8], frame[9], frame[10], frame[11]]),
        };
        if header.version != FRAME_VERSION || header.flags != 0 {
            return Err(FrameError::Violation);
        }
        Ok((header, &frame[FRAME_HEADER_LEN..]))
    }
}

/// Receiver-side sequence rule for one `(requestId, channel)` (§2.3).
///
/// `seq` starts at zero and advances for every produced chunk, including
/// deliberately dropped ones. A lossless (`pause`) channel requires exactly
/// the next seq; `dropOldest` permits forward gaps. Repeats, decreases, and
/// anything after `u32::MAX` (a wrap) are violations.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChannelSeq {
    /// Next acceptable seq; `2^32` once `u32::MAX` was consumed.
    expected: u64,
}

impl ChannelSeq {
    /// Accept `seq` under `overflow`, advancing the tracker; `false` is a
    /// violation (the tracker is left unchanged).
    pub fn accept(&mut self, overflow: Overflow, seq: u32) -> bool {
        let seq = u64::from(seq);
        let ok = match overflow {
            Overflow::DropOldest => seq >= self.expected,
            Overflow::Pause | Overflow::None => seq == self.expected,
        };
        if ok {
            self.expected = seq + 1;
        }
        ok
    }

    /// The lowest seq acceptable next, or `None` once `u32::MAX` was
    /// consumed (anything further would wrap). Diagnostics only.
    pub fn expected(&self) -> Option<u32> {
        u32::try_from(self.expected).ok()
    }
}

// ---------------------------------------------------------------------------
// Capability registry (provisional v1 set)
// ---------------------------------------------------------------------------

/// Operation shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Unary,
    Stream,
}

/// What flows on the data plane, and in which direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataPlane {
    /// No data plane beyond params/result.
    None,
    /// JSON `deviceEvent`s, client → server.
    JsonEvents,
    /// Binary frames, client → server.
    BinaryUpload,
    /// Binary frames, server → client. `initialCredit` MUST be zero.
    BinaryDownload,
}

/// Consent policy enforced by DeviceHost (§2.6/§5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Consent {
    /// Never prompts (e.g. `permission.query`, protocol control).
    None,
    /// Prompt or user-mediated picker on every operation.
    PerUse,
    /// Grant may persist with finite expiry and re-affirmation.
    Persistable,
}

/// Overflow policy for the data plane when credit is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Overflow {
    /// No data plane / not applicable.
    None,
    /// Drop stale items; `seq` gaps account for drops.
    DropOldest,
    /// Sender pauses (or spools within a bounded budget) and reports `paused`.
    Pause,
}

/// One immutable capability revision. Adding an optional field to any schema
/// creates a NEW revision; old encoders and validators remain available.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRevision {
    pub version: u32,
    pub mode: Mode,
    pub data: DataPlane,
    pub consent: Consent,
    pub overflow: Overflow,
    /// Lifetimes a request may select. First entry is the default.
    pub lifetimes: &'static [Lifetime],
    /// Hard cap on a single blob item, bytes (0 = no blob items).
    pub max_item_bytes: u64,
    /// Hard cap on blob items / channels per request.
    pub max_items: u16,
    /// Upper bound for `initialCredit` (0 for server→client data planes).
    pub max_initial_credit: u64,
    /// Upper bound on outstanding (granted, unspent) credit.
    pub max_outstanding_credit: u64,
    /// Upper bound a request's `timeoutMs` may take.
    pub max_timeout_ms: u64,
}

/// A declared capability: name plus its revisions, ascending by version.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CapabilityDecl {
    pub name: &'static str,
    pub revisions: &'static [CapabilityRevision],
}

const KIB: u64 = 1024;
const MIB: u64 = 1024 * 1024;

const ACTIVATION_ONLY: &[Lifetime] = &[Lifetime::Activation];
const CONNECTION_ONLY: &[Lifetime] = &[Lifetime::Connection];

/// The provisional v1 capability registry (RFC 001 §3). Order is stable and
/// alphabetical after the reserved `core.*` block.
pub fn registry() -> &'static [CapabilityDecl] {
    &[
        CapabilityDecl {
            name: "core.capabilities",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Stream,
                data: DataPlane::JsonEvents,
                consent: Consent::None,
                overflow: Overflow::DropOldest, // coalesces to one latest snapshot
                lifetimes: CONNECTION_ONLY,
                max_item_bytes: 0,
                max_items: 0,
                max_initial_credit: 64,
                max_outstanding_credit: 64,
                max_timeout_ms: 86_400_000, // finite overall deadline; broker reopens
            }],
        },
        CapabilityDecl {
            name: "bluetooth.scan",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Stream,
                data: DataPlane::JsonEvents,
                consent: Consent::Persistable,
                overflow: Overflow::DropOldest,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 0,
                max_items: 0,
                max_initial_credit: 256,
                max_outstanding_credit: 1024,
                max_timeout_ms: 600_000,
            }],
        },
        CapabilityDecl {
            name: "bluetooth.select",
            // Identity only (no GATT): the host-owned chooser is the per-use
            // consent gate and the visible UI while the scan behind it runs.
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::None,
                consent: Consent::PerUse,
                overflow: Overflow::None,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 0,
                max_items: 0,
                max_initial_credit: 0,
                max_outstanding_credit: 0,
                max_timeout_ms: 300_000,
            }],
        },
        CapabilityDecl {
            name: "camera.capture",
            // The host's own capture UI (preview + Capture/Record/Cancel) is
            // the per-use consent gate, like the gallery picker. Exactly one
            // item; a recording's size is unknown until it ends.
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::BinaryUpload,
                consent: Consent::PerUse,
                overflow: Overflow::Pause,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 64 * MIB,
                max_items: 1,
                max_initial_credit: 4 * MIB,
                max_outstanding_credit: 8 * MIB,
                max_timeout_ms: 600_000,
            }],
        },
        CapabilityDecl {
            name: "file.pick",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::BinaryUpload,
                consent: Consent::PerUse,
                overflow: Overflow::Pause,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 64 * MIB,
                max_items: 16,
                max_initial_credit: 4 * MIB,
                max_outstanding_credit: 8 * MIB,
                max_timeout_ms: 300_000,
            }],
        },
        CapabilityDecl {
            name: "file.save",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::BinaryDownload,
                consent: Consent::PerUse,
                overflow: Overflow::Pause,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 64 * MIB,
                max_items: 1,
                max_initial_credit: 0, // server→client: MUST be zero (§2.3)
                max_outstanding_credit: 8 * MIB,
                max_timeout_ms: 300_000,
            }],
        },
        CapabilityDecl {
            name: "gallery.pick",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::BinaryUpload,
                consent: Consent::PerUse,
                overflow: Overflow::Pause,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 64 * MIB,
                max_items: 16,
                max_initial_credit: 4 * MIB,
                max_outstanding_credit: 8 * MIB,
                max_timeout_ms: 300_000,
            }],
        },
        CapabilityDecl {
            name: "mic.record",
            // Bounded foreground pilot (§6 Phase 4, §8): encoding, duration and
            // overflow policy are settled on real-driver evidence before this
            // schema is published. Capture gaps must be visible, never called
            // lossless.
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Stream,
                data: DataPlane::BinaryUpload,
                consent: Consent::PerUse,
                overflow: Overflow::Pause,
                lifetimes: ACTIVATION_ONLY, // background opt-in is a later revision
                max_item_bytes: 64 * MIB,
                max_items: 1,
                max_initial_credit: 256 * KIB,
                max_outstanding_credit: MIB,
                max_timeout_ms: 600_000,
            }],
        },
        CapabilityDecl {
            name: "permission.query",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::None,
                consent: Consent::None,
                overflow: Overflow::None,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 0,
                max_items: 0,
                max_initial_credit: 0,
                max_outstanding_credit: 0,
                max_timeout_ms: 30_000,
            }],
        },
        CapabilityDecl {
            name: "permission.request",
            revisions: &[CapabilityRevision {
                version: 1,
                mode: Mode::Unary,
                data: DataPlane::None,
                consent: Consent::PerUse,
                overflow: Overflow::None,
                lifetimes: ACTIVATION_ONLY,
                max_item_bytes: 0,
                max_items: 0,
                max_initial_credit: 0,
                max_outstanding_credit: 0,
                max_timeout_ms: 300_000,
            }],
        },
    ]
}

impl DataPlane {
    /// Binary frames flow on this plane: selectable only when the handshake
    /// negotiated `binary: true` (§2.5).
    pub fn is_binary(self) -> bool {
        matches!(self, DataPlane::BinaryUpload | DataPlane::BinaryDownload)
    }
}

fn registry_max(f: impl Fn(&CapabilityRevision) -> u64) -> u64 {
    registry()
        .iter()
        .flat_map(|c| c.revisions.iter())
        .map(f)
        .max()
        .unwrap_or(0)
}

/// Largest `max_timeout_ms` of any revision: the envelope-level `timeoutMs` bound.
pub fn registry_max_timeout_ms() -> u64 {
    registry_max(|r| r.max_timeout_ms)
}

/// Largest `max_initial_credit` of any revision: the envelope-level bound.
pub fn registry_max_initial_credit() -> u64 {
    registry_max(|r| r.max_initial_credit)
}

/// Largest `max_outstanding_credit` of any revision: the envelope-level
/// `grant` bound.
pub fn registry_max_outstanding_credit() -> u64 {
    registry_max(|r| r.max_outstanding_credit)
}

/// Largest `max_item_bytes` of any revision.
pub fn registry_max_item_bytes() -> u64 {
    registry_max(|r| r.max_item_bytes)
}

/// Look up a declared capability revision.
pub fn find_revision(name: &str, version: u32) -> Option<&'static CapabilityRevision> {
    registry()
        .iter()
        .find(|c| c.name == name)?
        .revisions
        .iter()
        .find(|r| r.version == version)
}

/// Why a receiver refuses a decoded `deviceRequest` (RFC 001 §2.1/§3): the
/// terminal error code the detecting client sends, plus a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: DeviceErrorCode,
    /// A payload refusal names the failing JSON path and rule
    /// ([`validate_payload`]); envelope-level ones are fixed texts.
    pub reason: std::borrow::Cow<'static, str>,
}

impl Rejection {
    fn unsupported(reason: &'static str) -> Self {
        Rejection {
            code: DeviceErrorCode::Unsupported,
            reason: reason.into(),
        }
    }
    fn invalid(reason: impl Into<std::borrow::Cow<'static, str>>) -> Self {
        Rejection {
            code: DeviceErrorCode::InvalidParams,
            reason: reason.into(),
        }
    }
}

/// Per-revision request admission, shared by every SDK (RFC 001 §2.1/§2.3):
/// the revision must be declared (else `unsupported`), and the request's
/// lifetime, `timeoutMs`, `initialCredit` (zero for server→client data) and
/// typed params must fit that revision (else `invalidParams`). Connection
/// state — whether the revision is in the live negotiated selection, the
/// `core.capabilities` ordering, owner activation order — is the broker's
/// job (see the transcript runner); a revision outside the live selection
/// is also `unsupported`.
pub fn validate_request(req: &DeviceRequest) -> Result<&'static CapabilityRevision, Rejection> {
    let rev = find_revision(&req.capability, req.version)
        .ok_or(Rejection::unsupported("revision not in the registry"))?;
    if !rev.lifetimes.contains(&req.lifetime) {
        return Err(Rejection::invalid("lifetime not allowed by revision"));
    }
    if req.timeout_ms > rev.max_timeout_ms {
        return Err(Rejection::invalid("timeoutMs above revision max"));
    }
    if req.initial_credit > rev.max_initial_credit {
        return Err(Rejection::invalid("initialCredit above revision max"));
    }
    if rev.data == DataPlane::BinaryDownload && req.initial_credit != 0 {
        return Err(Rejection::invalid("download initialCredit must be 0"));
    }
    validate_payload(
        &req.capability,
        req.version,
        PayloadKind::Params,
        &req.params,
    )
    .map_err(|why| Rejection::invalid(format!("params {why}")))?;
    Ok(rev)
}

// ---------------------------------------------------------------------------
// Capability payload types (provisional revision 1 schemas)
// ---------------------------------------------------------------------------

/// Single-variant tag for [`BlobStart`]: serde's internally tagged structs do
/// not verify the tag value, so the tag is an explicit field.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlobStartKind {
    #[default]
    #[serde(rename = "blobStart")]
    BlobStart,
}

/// A blob item announcement, client → server, before any bytes on its channel.
/// Wire shape: `{"kind":"blobStart","channel":0,"contentType":"…","bytes":n?}`.
///
/// `bytes` is optional on every binary-upload revision (RFC 001 §2.4):
/// present, it is an exact declaration (an existing picked file) checked when
/// the item ends; absent, the length is unknown (microphone, camera, an item
/// being transcoded) and the sender just streams. Limits never come from the
/// declaration: the receiver enforces the revision's `maxItemBytes` and its
/// retained-bytes budget as bytes arrive. A zero-byte item is announced with
/// `bytes: 0` (or undeclared) and sends no frames at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobStart {
    pub kind: BlobStartKind,
    pub channel: u16,
    pub content_type: String,
    #[serde(
        default,
        deserialize_with = "de_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub bytes: Option<u64>,
}

impl BlobStart {
    /// Channel within the revision's item count; a declared size within the
    /// per-item cap.
    pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
        validate_blob_meta("$", self.channel, &self.content_type, self.bytes, rev)
    }
}

/// Item metadata bounds; `at` is the item's JSON path in the payload.
fn validate_blob_meta(
    at: &str,
    channel: u16,
    content_type: &str,
    bytes: Option<u64>,
    rev: &CapabilityRevision,
) -> Result<(), String> {
    if u64::from(channel) >= u64::from(rev.max_items) {
        return Err(refuse(
            &format!("{at}.channel"),
            format!(
                "channel {channel} outside the revision's item range 0..{}",
                rev.max_items
            ),
        ));
    }
    check_len_at(
        &format!("{at}.contentType"),
        content_type,
        0,
        limits::CONTENT_TYPE_MAX,
    )?;
    if let Some(b) = bytes.filter(|&b| b > rev.max_item_bytes) {
        return Err(refuse(
            &format!("{at}.bytes"),
            format!(
                "item of {b} bytes exceeds the revision's max_item_bytes {}",
                rev.max_item_bytes
            ),
        ));
    }
    Ok(())
}

/// A completed blob item as reported in a terminal result: always the
/// item's actual byte count and SHA-256, which must equal what was received
/// (and the declaration, when `blobStart` declared one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobItem {
    pub channel: u16,
    pub content_type: String,
    pub bytes: u64,
    /// Lowercase hex SHA-256 of the item's bytes. Detects mismatch against the
    /// declaration; it does not establish authenticity.
    pub sha256: String,
}

impl BlobItem {
    pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
        self.validate_at(rev, "$")
    }

    /// As [`Self::validate`], naming fields under the item's path `at`.
    pub fn validate_at(&self, rev: &CapabilityRevision, at: &str) -> Result<(), String> {
        validate_blob_meta(at, self.channel, &self.content_type, Some(self.bytes), rev)?;
        if !is_sha256_hex(&self.sha256) {
            return Err(refuse(
                &format!("{at}.sha256"),
                "sha256 must be 64 lowercase hex digits",
            ));
        }
        Ok(())
    }
}

/// Optional progress state (§2.1/§2.6): `pendingConsent` while DeviceHost
/// awaits its own interaction, `running` once admitted. Client → server,
/// allowed on every revision, consumes no data credit, and server
/// correctness never depends on receiving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    PendingConsent,
    Running,
}

/// Single-variant tag for [`ProgressEvent`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProgressKind {
    #[default]
    #[serde(rename = "progress")]
    Progress,
}

/// Wire shape: `{"kind":"progress","state":"pendingConsent"|"running"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressEvent {
    pub kind: ProgressKind,
    pub state: ProgressState,
}

pub mod payloads {
    //! Params / result / event types per capability revision 1. These are the
    //! declarations the exported JSON Schemas are generated from; every schema
    //! is closed (`additionalProperties: false` via `deny_unknown_fields`).
    //! Bounds that depend on the selected revision take it as an argument.

    use super::{
        all_unique, check_len_at, is_bluetooth_uuid, is_sha256_hex, limits, refuse, BlobItem,
        CapabilityOffer, CapabilityRevision, JSON_SAFE_MAX,
    };
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum MediaType {
        Photo,
        Video,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GalleryPickParams {
        /// Non-empty, no duplicates.
        pub media_types: Vec<MediaType>,
        /// 1..=`max_items` of the revision; also bounds the channel range.
        pub max_count: u16,
    }

    impl GalleryPickParams {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.media_types.is_empty() || !all_unique(&self.media_types) {
                return Err(refuse(
                    "$.mediaTypes",
                    "mediaTypes must be non-empty and unique",
                ));
            }
            validate_max_count(self.max_count, rev)
        }
    }

    fn validate_max_count(max_count: u16, rev: &CapabilityRevision) -> Result<(), String> {
        if max_count == 0 || max_count > rev.max_items {
            return Err(refuse(
                "$.maxCount",
                format!("maxCount {max_count} out of bounds 1..={}", rev.max_items),
            ));
        }
        Ok(())
    }

    /// The `$.items` array: at most `max_items`, each item valid (checked
    /// under `$.items[i]`), channels unique.
    fn validate_items(items: &[BlobItem], rev: &CapabilityRevision) -> Result<(), String> {
        validate_item_list(
            items
                .iter()
                .enumerate()
                .map(|(i, it)| (it.channel, it.validate_at(rev, &format!("$.items[{i}]")))),
            rev,
        )
    }

    fn validate_item_list(
        items: impl ExactSizeIterator<Item = (u16, Result<(), String>)>,
        rev: &CapabilityRevision,
    ) -> Result<(), String> {
        if items.len() > usize::from(rev.max_items) {
            return Err(refuse(
                "$.items",
                format!("too many items ({} > {})", items.len(), rev.max_items),
            ));
        }
        let mut channels = Vec::new();
        for (channel, check) in items {
            check?;
            channels.push(channel);
        }
        if !all_unique(&channels) {
            return Err(refuse("$.items", "duplicate item channel"));
        }
        Ok(())
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GalleryPickResult {
        pub items: Vec<BlobItem>,
    }

    impl GalleryPickResult {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            validate_items(&self.items, rev)
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FilePickParams {
        /// Accepted MIME types or patterns (e.g. `application/pdf`, `image/*`).
        pub accept: Vec<String>,
        pub max_count: u16,
    }

    impl FilePickParams {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.accept.len() > limits::ACCEPT_MAX_ITEMS {
                return Err(refuse(
                    "$.accept",
                    format!(
                        "too many accept entries ({} > {})",
                        self.accept.len(),
                        limits::ACCEPT_MAX_ITEMS
                    ),
                ));
            }
            for (i, a) in self.accept.iter().enumerate() {
                check_len_at(&format!("$.accept[{i}]"), a, 0, limits::ACCEPT_ENTRY_MAX)?;
            }
            validate_max_count(self.max_count, rev)
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FileItem {
        pub channel: u16,
        pub name: String,
        pub content_type: String,
        pub bytes: u64,
        pub sha256: String,
    }

    impl FileItem {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            self.validate_at(rev, "$")
        }

        /// As [`Self::validate`], naming fields under the item's path `at`.
        pub fn validate_at(&self, rev: &CapabilityRevision, at: &str) -> Result<(), String> {
            check_len_at(&format!("{at}.name"), &self.name, 0, limits::FILE_NAME_MAX)?;
            BlobItem {
                channel: self.channel,
                content_type: self.content_type.clone(),
                bytes: self.bytes,
                sha256: self.sha256.clone(),
            }
            .validate_at(rev, at)
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FilePickResult {
        pub items: Vec<FileItem>,
    }

    impl FilePickResult {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            validate_item_list(
                self.items
                    .iter()
                    .enumerate()
                    .map(|(i, it)| (it.channel, it.validate_at(rev, &format!("$.items[{i}]")))),
                rev,
            )
        }
    }

    /// `file.save` params ARE the announcement for the single download channel.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FileSaveParams {
        /// Always 0 in revision 1.
        pub channel: u16,
        pub name: String,
        pub content_type: String,
        /// 1..=`max_item_bytes`.
        pub bytes: u64,
        pub sha256: String,
    }

    impl FileSaveParams {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.channel != 0 {
                return Err(refuse("$.channel", "file.save channel must be 0"));
            }
            check_len_at("$.name", &self.name, 0, limits::FILE_NAME_MAX)?;
            check_len_at(
                "$.contentType",
                &self.content_type,
                0,
                limits::CONTENT_TYPE_MAX,
            )?;
            if self.bytes == 0 || self.bytes > rev.max_item_bytes {
                return Err(refuse(
                    "$.bytes",
                    format!(
                        "bytes {} out of bounds 1..={}",
                        self.bytes, rev.max_item_bytes
                    ),
                ));
            }
            if !is_sha256_hex(&self.sha256) {
                return Err(refuse("$.sha256", "sha256 must be 64 lowercase hex digits"));
            }
            Ok(())
        }
    }

    /// Write receipt: the client verified size and hash before success.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FileSaveResult {
        pub bytes_written: u64,
    }

    impl FileSaveResult {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.bytes_written > rev.max_item_bytes {
                return Err(refuse(
                    "$.bytesWritten",
                    format!(
                        "bytesWritten {} out of bounds 0..={}",
                        self.bytes_written, rev.max_item_bytes
                    ),
                ));
            }
            Ok(())
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum PermissionStatus {
        Granted,
        Denied,
        Prompt,
    }

    /// The closed permission set of `permission.query@1` /
    /// `permission.request@1` (RFC 001 §3). Every host maps the SAME names;
    /// anything else is `invalidParams` at decode. A host that cannot
    /// represent one of these at all answers `unsupported` with
    /// `platformDetail` = the permission name.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum Permission {
        Camera,
        Microphone,
        Photos,
        Location,
        Notifications,
        Bluetooth,
        Contacts,
    }

    impl Permission {
        /// Every permission, in wire (schema `enum`) order.
        pub const ALL: [Permission; 7] = [
            Permission::Camera,
            Permission::Microphone,
            Permission::Photos,
            Permission::Location,
            Permission::Notifications,
            Permission::Bluetooth,
            Permission::Contacts,
        ];

        /// The wire name (also the `unsupported` error's `platformDetail`).
        pub fn as_str(self) -> &'static str {
            match self {
                Permission::Camera => "camera",
                Permission::Microphone => "microphone",
                Permission::Photos => "photos",
                Permission::Location => "location",
                Permission::Notifications => "notifications",
                Permission::Bluetooth => "bluetooth",
                Permission::Contacts => "contacts",
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct PermissionParams {
        pub permission: Permission,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct PermissionResult {
        pub status: PermissionStatus,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothScanParams {}

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothDevice {
        pub id: String,
        /// `""` is present; `null` is rejected.
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub name: Option<String>,
        pub rssi: i16,
    }

    impl BluetoothDevice {
        /// Bounds of a `bluetooth.scan@1` event's `device` (named under
        /// `$.device`).
        pub fn validate(&self) -> Result<(), String> {
            check_len_at("$.device.id", &self.id, 0, limits::BLUETOOTH_ID_MAX)?;
            if let Some(name) = &self.name {
                check_len_at("$.device.name", name, 0, limits::BLUETOOTH_NAME_MAX)?;
            }
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothScanEvent {
        pub device: BluetoothDevice,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothScanResult {}

    /// Bounded foreground pilot; provisional until Phase 4 evidence (§8).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MicRecordParams {
        /// 8000..=192000 Hz.
        pub sample_rate: u32,
        /// v1 pilot: `pcm16` only; final encoding set is a Phase 4 decision.
        pub format: MicFormat,
        /// Optional recording limit, 1..=600000 ms: a duration bound, never a
        /// size. A live recording's byte count is unknown until it ends, so
        /// its `blobStart` carries no `bytes` (RFC 001 §2.4).
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub max_duration_ms: Option<u64>,
        /// Optional channel count, 1 (default when absent) or 2. Frames carry
        /// little-endian PCM16 samples, interleaved when 2.
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub channels: Option<u8>,
    }

    impl MicRecordParams {
        pub fn validate(&self) -> Result<(), String> {
            if !(limits::MIC_SAMPLE_RATE_MIN..=limits::MIC_SAMPLE_RATE_MAX)
                .contains(&self.sample_rate)
            {
                return Err(refuse(
                    "$.sampleRate",
                    format!(
                        "sampleRate {} out of bounds {}..={}",
                        self.sample_rate,
                        limits::MIC_SAMPLE_RATE_MIN,
                        limits::MIC_SAMPLE_RATE_MAX
                    ),
                ));
            }
            if let Some(ms) = self.max_duration_ms {
                if ms == 0 || ms > limits::MIC_MAX_DURATION_MS {
                    return Err(refuse(
                        "$.maxDurationMs",
                        format!(
                            "maxDurationMs {ms} out of bounds 1..={}",
                            limits::MIC_MAX_DURATION_MS
                        ),
                    ));
                }
            }
            if let Some(ch) = self.channels {
                if ch == 0 || ch > limits::MIC_CHANNELS_MAX {
                    return Err(refuse("$.channels", "channels must be 1 or 2"));
                }
            }
            Ok(())
        }

        /// The effective channel count (absent = 1).
        pub fn channel_count(&self) -> u8 {
            self.channels.unwrap_or(1)
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum MicFormat {
        Pcm16,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MicRecordResult {
        pub duration_ms: u64,
        pub item: BlobItem,
    }

    impl MicRecordResult {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.duration_ms > JSON_SAFE_MAX {
                return Err(refuse("$.durationMs", "durationMs out of bounds"));
            }
            self.item.validate_at(rev, "$.item")
        }
    }

    /// `camera.capture@1` capture kind.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum CaptureMode {
        Photo,
        Video,
    }

    /// `camera.capture@1` preferred camera; the host may fall back when the
    /// device has only one.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum CameraFacing {
        Front,
        Back,
    }

    /// Content types a `camera.capture@1` photo item may carry.
    pub const CAMERA_PHOTO_CONTENT_TYPES: &[&str] = &["image/jpeg", "image/heic"];
    /// Content types a `camera.capture@1` video item may carry (bare media
    /// types: drivers strip codec parameters such as `;codecs=vp8`).
    pub const CAMERA_VIDEO_CONTENT_TYPES: &[&str] = &["video/mp4", "video/quicktime", "video/webm"];

    /// Every content type a `camera.capture@1` item (`blobStart` and
    /// result) may carry. Which of them fits the requested `mode` is a
    /// cross-message rule the receiver checks against the request.
    pub fn camera_content_types() -> impl Iterator<Item = &'static str> {
        CAMERA_PHOTO_CONTENT_TYPES
            .iter()
            .chain(CAMERA_VIDEO_CONTENT_TYPES)
            .copied()
    }

    /// `camera.capture@1` params. The host's own capture UI (live preview
    /// with Capture / Record-Stop / Cancel) is the per-use consent gate.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CameraCaptureParams {
        pub mode: CaptureMode,
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub facing: Option<CameraFacing>,
        /// Video only: recording limit 1..=600000 ms (never a size). Present
        /// with `mode: "photo"` it is `invalidParams`.
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub max_duration_ms: Option<u64>,
    }

    impl CameraCaptureParams {
        pub fn validate(&self) -> Result<(), String> {
            match (self.mode, self.max_duration_ms) {
                (CaptureMode::Photo, Some(_)) => Err(refuse(
                    "$.maxDurationMs",
                    "maxDurationMs is only valid for video",
                )),
                (CaptureMode::Video, Some(ms))
                    if ms == 0 || ms > limits::CAMERA_MAX_DURATION_MS =>
                {
                    Err(refuse(
                        "$.maxDurationMs",
                        format!(
                            "maxDurationMs {ms} out of bounds 1..={}",
                            limits::CAMERA_MAX_DURATION_MS
                        ),
                    ))
                }
                _ => Ok(()),
            }
        }

        /// Whether `content_type` fits this request's mode.
        pub fn accepts_content_type(&self, content_type: &str) -> bool {
            let set = match self.mode {
                CaptureMode::Photo => CAMERA_PHOTO_CONTENT_TYPES,
                CaptureMode::Video => CAMERA_VIDEO_CONTENT_TYPES,
            };
            set.contains(&content_type)
        }
    }

    /// `camera.capture@1` result: exactly one item (channel 0).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CameraCaptureResult {
        pub items: Vec<BlobItem>,
    }

    impl CameraCaptureResult {
        pub fn validate(&self, rev: &CapabilityRevision) -> Result<(), String> {
            if self.items.len() != 1 {
                return Err(refuse(
                    "$.items",
                    format!(
                        "camera.capture result carries exactly one item, got {}",
                        self.items.len()
                    ),
                ));
            }
            validate_items(&self.items, rev)?;
            if !camera_content_types().any(|ct| ct == self.items[0].content_type) {
                return Err(refuse(
                    "$.items[0].contentType",
                    "contentType not a camera.capture media type",
                ));
            }
            Ok(())
        }
    }

    /// `bluetooth.select@1` params: optional filters for the host-owned
    /// chooser. Absent filters list every nearby device.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothSelectParams {
        /// 1..=16 unique service UUIDs, each in the canonical lowercase
        /// 128-bit form (a 16-bit SIG id is sent expanded).
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub services: Option<Vec<String>>,
        /// 1..=64 code points.
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub name_prefix: Option<String>,
    }

    impl BluetoothSelectParams {
        pub fn validate(&self) -> Result<(), String> {
            if let Some(services) = &self.services {
                if services.is_empty() || services.len() > limits::BLUETOOTH_SERVICES_MAX {
                    return Err(refuse(
                        "$.services",
                        format!(
                            "services must hold 1..={} entries, got {}",
                            limits::BLUETOOTH_SERVICES_MAX,
                            services.len()
                        ),
                    ));
                }
                if let Some(i) = services.iter().position(|u| !is_bluetooth_uuid(u)) {
                    return Err(refuse(
                        &format!("$.services[{i}]"),
                        "service UUID not in canonical lowercase 128-bit form",
                    ));
                }
                if !all_unique(services) {
                    return Err(refuse("$.services", "duplicate service UUID"));
                }
            }
            if let Some(prefix) = &self.name_prefix {
                check_len_at("$.namePrefix", prefix, 1, limits::BLUETOOTH_NAME_PREFIX_MAX)?;
            }
            Ok(())
        }
    }

    /// The device the user chose: identity only (no GATT in revision 1).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SelectedBluetoothDevice {
        /// Host-scoped opaque identifier, 1..=128 code points.
        pub id: String,
        /// `""` is present; `null` is rejected.
        #[serde(
            default,
            deserialize_with = "super::de_present",
            skip_serializing_if = "Option::is_none"
        )]
        pub name: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct BluetoothSelectResult {
        pub device: SelectedBluetoothDevice,
    }

    impl BluetoothSelectResult {
        pub fn validate(&self) -> Result<(), String> {
            check_len_at("$.device.id", &self.device.id, 1, limits::BLUETOOTH_ID_MAX)?;
            if let Some(name) = &self.device.name {
                check_len_at("$.device.name", name, 0, limits::BLUETOOTH_NAME_MAX)?;
            }
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CoreCapabilitiesParams {}

    pub type CoreCapabilitiesEvent = super::CapabilitiesEvent;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CoreCapabilitiesResult {}

    // Re-export for schema generation convenience.
    pub use super::CapabilityOffer as AdvertisedCapability;
    const _: fn() = || {
        // Compile-time reminder that CapabilityOffer participates in payloads.
        let _ = |x: CapabilityOffer| x;
    };
}

/// Which capability-revision schema a payload is checked against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadKind {
    Params,
    Result,
    Event,
}

/// A capability event after typed decoding against its selected revision.
#[derive(Debug, Clone, PartialEq)]
pub enum TypedEvent {
    Progress(ProgressEvent),
    BlobStart(BlobStart),
    Capabilities(CapabilitiesEvent),
    BluetoothDevice(payloads::BluetoothScanEvent),
}

/// Closed typed decoding of a payload plus canonical round-trip (an array
/// never stands in for an object, nor a one-key map for an enum string).
/// A refusal names the JSON path and the rule that failed
/// (`$.mediaTypes[0]: unknown variant `vid`, expected `photo` or `video``),
/// bounded in length.
fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> Result<T, String> {
    // Every payload is a closed object; serde would otherwise try a struct's
    // positional (array) form and blame an element instead.
    let found = match value {
        Value::Object(_) => None,
        Value::Array(_) => Some("an array"),
        Value::String(_) => Some("a string"),
        Value::Number(_) => Some("a number"),
        Value::Bool(_) => Some("a boolean"),
        Value::Null => Some("null"),
    };
    if let Some(found) = found {
        return Err(format!("$: expected a JSON object, got {found}"));
    }
    // Plain decoding on the hot path; only a refusal pays for re-decoding
    // with path tracking (deterministic: it fails at the same place).
    let t: T = match T::deserialize(value) {
        Ok(t) => t,
        Err(plain) => {
            return Err(match serde_path_to_error::deserialize::<_, T>(value) {
                Err(e) => {
                    let path = format_path(e.path().iter().filter_map(|seg| match seg {
                        serde_path_to_error::Segment::Seq { index } => Some(PathSeg::Index(*index)),
                        serde_path_to_error::Segment::Map { key } => {
                            Some(PathSeg::Key(key.as_str()))
                        }
                        _ => None,
                    }));
                    bounded(refuse(&path, e.inner()))
                }
                Ok(_) => bounded(refuse("$", plain)),
            });
        }
    };
    let back = serde_json::to_value(&t).map_err(|e| bounded(refuse("$", e)))?;
    if back != *value {
        let mut path = Vec::new();
        first_difference(value, &back, &mut path);
        return Err(bounded(refuse(
            &format_path(path),
            "non-canonical encoding (array for an object or map for an enum)",
        )));
    }
    Ok(t)
}

/// The refusal for an event kind a revision does not define.
pub const EVENT_NOT_DEFINED: &str = "$.kind: event not defined for this capability revision";
/// The refusal for a registry revision with no payload declaration (the
/// schema-export test keeps this unreachable).
pub const NO_PAYLOAD_DECLARATION: &str = "$: no payload declaration for this capability revision";

fn unknown_revision(capability: &str, version: u32) -> String {
    bounded(format!(
        "$: {capability}@{version} is not a registry revision"
    ))
}

/// Decode a capability event against the selected revision's event union:
/// `progress` on every revision, `blobStart` on binary-upload revisions, and
/// the capability's own stream events. A refusal names the failing JSON path
/// and rule (see [`validate_payload`]).
pub fn decode_event(capability: &str, version: u32, event: &Value) -> Result<TypedEvent, String> {
    let rev =
        find_revision(capability, version).ok_or_else(|| unknown_revision(capability, version))?;
    check_payload_json(event)?;
    match event.get("kind").and_then(Value::as_str) {
        Some("progress") => return typed(event).map(TypedEvent::Progress),
        Some("blobStart") if rev.data == DataPlane::BinaryUpload => {
            let bs: BlobStart = typed(event)?;
            bs.validate(rev)?;
            if (capability, version) == ("camera.capture", 1)
                && !payloads::camera_content_types().any(|ct| ct == bs.content_type)
            {
                return Err(refuse(
                    "$.contentType",
                    "contentType not a camera.capture media type",
                ));
            }
            return Ok(TypedEvent::BlobStart(bs));
        }
        _ => {}
    }
    match (capability, version) {
        (CORE_CAPABILITIES, 1) => {
            let ev: CapabilitiesEvent = typed(event)?;
            ev.validate().map_err(|e| refuse("$.capabilities", e))?;
            Ok(TypedEvent::Capabilities(ev))
        }
        ("bluetooth.scan", 1) => {
            let ev: payloads::BluetoothScanEvent = typed(event)?;
            ev.device.validate()?;
            Ok(TypedEvent::BluetoothDevice(ev))
        }
        _ => Err(EVENT_NOT_DEFINED.to_string()),
    }
}

/// Request-dependent `blobStart` metadata rules (RFC 001 §2.4, "disallowed
/// metadata"): an announced item must fit the params of the request it
/// belongs to, beyond what the revision's event schema alone expresses.
/// `camera.capture@1`: a `photo` item is `image/jpeg` or `image/heic`, a
/// `video` item `video/mp4`, `video/quicktime` or `video/webm`. Assumes
/// `params` already passed [`validate_payload`] and `blob_start` passed
/// [`decode_event`]; every other revision has no such rule.
pub fn validate_blob_start_for_request(
    capability: &str,
    version: u32,
    params: &Value,
    blob_start: &BlobStart,
) -> Result<(), String> {
    match (capability, version) {
        ("camera.capture", 1) => {
            let params: payloads::CameraCaptureParams = typed(params)?;
            if params.accepts_content_type(&blob_start.content_type) {
                Ok(())
            } else {
                Err(refuse(
                    "$.contentType",
                    "contentType does not fit the requested capture mode",
                ))
            }
        }
        _ => Ok(()),
    }
}

/// Validate a params/result/event payload against the exact selected
/// revision: typed (closed) decoding plus every bound the revision schema
/// carries, and rules no schema keyword expresses (unique channels, unique
/// capability names). Every registry revision has a case here; the
/// schema-export test fails if one is missing.
///
/// A refusal is `<JSON path>: <rule>` — the failing field and the rule it
/// broke, e.g. `$.maxCount: maxCount 0 out of bounds 1..=16`,
/// `$.items[1].sha256: sha256 must be 64 lowercase hex digits`,
/// `$.permission: unknown variant `camra`, expected one of …` or
/// `$: unknown field `extra`, expected …` — so every SDK on the Rust broker
/// reports the same diagnostics (bounded to a few hundred characters).
pub fn validate_payload(
    capability: &str,
    version: u32,
    kind: PayloadKind,
    value: &Value,
) -> Result<(), String> {
    use payloads::*;
    let rev =
        find_revision(capability, version).ok_or_else(|| unknown_revision(capability, version))?;
    check_payload_json(value)?;
    if kind == PayloadKind::Event {
        return decode_event(capability, version, value).map(|_| ());
    }
    let params = kind == PayloadKind::Params;
    match (capability, version) {
        (CORE_CAPABILITIES, 1) => {
            if params {
                typed::<CoreCapabilitiesParams>(value).map(|_| ())
            } else {
                typed::<CoreCapabilitiesResult>(value).map(|_| ())
            }
        }
        ("bluetooth.scan", 1) => {
            if params {
                typed::<BluetoothScanParams>(value).map(|_| ())
            } else {
                typed::<BluetoothScanResult>(value).map(|_| ())
            }
        }
        ("bluetooth.select", 1) => {
            if params {
                typed::<BluetoothSelectParams>(value)?.validate()
            } else {
                typed::<BluetoothSelectResult>(value)?.validate()
            }
        }
        ("camera.capture", 1) => {
            if params {
                typed::<CameraCaptureParams>(value)?.validate()
            } else {
                typed::<CameraCaptureResult>(value)?.validate(rev)
            }
        }
        ("file.pick", 1) => {
            if params {
                typed::<FilePickParams>(value)?.validate(rev)
            } else {
                typed::<FilePickResult>(value)?.validate(rev)
            }
        }
        ("file.save", 1) => {
            if params {
                typed::<FileSaveParams>(value)?.validate(rev)
            } else {
                typed::<FileSaveResult>(value)?.validate(rev)
            }
        }
        ("gallery.pick", 1) => {
            if params {
                typed::<GalleryPickParams>(value)?.validate(rev)
            } else {
                typed::<GalleryPickResult>(value)?.validate(rev)
            }
        }
        ("mic.record", 1) => {
            if params {
                typed::<MicRecordParams>(value)?.validate()
            } else {
                typed::<MicRecordResult>(value)?.validate(rev)
            }
        }
        ("permission.query", 1) | ("permission.request", 1) => {
            if params {
                typed::<PermissionParams>(value).map(|_| ())
            } else {
                typed::<PermissionResult>(value).map(|_| ())
            }
        }
        _ => Err(NO_PAYLOAD_DECLARATION.to_string()),
    }
}

#[cfg(feature = "schema-export")]
pub mod schema;

#[cfg(test)]
mod tests {
    use super::payloads::*;
    use super::*;
    use serde_json::{json, Value};

    /// Refusals name the failing JSON path and rule (not a generic "does
    /// not match the revision schema"), bounded in length — the diagnostics
    /// every SDK on the Rust broker reports.
    #[test]
    fn payload_refusals_name_the_failing_field_and_rule() {
        use PayloadKind::*;
        let sha = "0".repeat(64);
        let item = |ch: u64, sha: &str| json!({"channel": ch, "contentType": "image/jpeg", "bytes": 1, "sha256": sha});
        let cases: Vec<(&str, PayloadKind, Value, &str)> = vec![
            ("gallery.pick", Params, json!({"mediaTypes": ["vid"], "maxCount": 1}),
             "$.mediaTypes[0]: unknown variant `vid`, expected `photo` or `video`"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"]}),
             "$: missing field `maxCount`"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"], "maxCount": "1"}),
             "$.maxCount: invalid type: string \"1\", expected u16"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"], "maxCount": 0}),
             "$.maxCount: maxCount 0 out of bounds 1..=16"),
            ("gallery.pick", Params, json!({"mediaTypes": [], "maxCount": 1}),
             "$.mediaTypes: mediaTypes must be non-empty and unique"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"], "maxCount": 1.5}),
             "$.maxCount: numbers are integers within 2^53 - 1"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"], "maxCount": 1, "odd key": 1.5}),
             "$[\"odd key\"]: numbers are integers within 2^53 - 1"),
            ("gallery.pick", Result, json!({"items": [item(0, &sha), item(1, "XYZ")]}),
             "$.items[1].sha256: sha256 must be 64 lowercase hex digits"),
            ("gallery.pick", Result, json!({"items": [item(0, &sha), item(0, &sha)]}),
             "$.items: duplicate item channel"),
            ("gallery.pick", Result, json!({"items": [item(99, &sha)]}),
             "$.items[0].channel: channel 99 outside the revision's item range 0..16"),
            ("permission.query", Params, json!({"permission": "camra"}),
             "$.permission: unknown variant `camra`, expected one of `camera`, `microphone`, `photos`, `location`, `notifications`, `bluetooth`, `contacts`"),
            ("permission.query", Params, json!({"permission": {"camera": null}}),
             "$.permission: non-canonical encoding (array for an object or map for an enum)"),
            ("bluetooth.select", Params, json!({"services": ["0000180d-0000-1000-8000-00805f9b34fb", "0x180D"]}),
             "$.services[1]: service UUID not in canonical lowercase 128-bit form"),
            ("file.pick", Params, json!({"accept": ["a".repeat(300)], "maxCount": 1}),
             "$.accept[0]: longer than 128 code points (300)"),
            ("file.save", Params, json!({"channel": 0, "name": "a", "contentType": "text/plain",
                                          "bytes": 0, "sha256": sha}),
             "$.bytes: bytes 0 out of bounds 1..=67108864"),
            ("mic.record", Params, json!({"sampleRate": 7, "format": "pcm16"}),
             "$.sampleRate: sampleRate 7 out of bounds 8000..=192000"),
            ("camera.capture", Params, json!({"mode": "photo", "maxDurationMs": 5}),
             "$.maxDurationMs: maxDurationMs is only valid for video"),
            ("core.capabilities", Event, json!({"capabilities": [
                {"name": "core.capabilities", "versions": [1]},
                {"name": "core.capabilities", "versions": [1]}]}),
             "$.capabilities: duplicate capability name"),
            ("bluetooth.scan", Event, json!({"device": {"id": "x".repeat(200), "rssi": 1}}),
             "$.device.id: longer than 128 code points (200)"),
            ("gallery.pick", Params, json!({"mediaTypes": ["photo"], "maxCount": 1, "extra": true}),
             "$.extra: unknown field `extra`, expected `mediaTypes` or `maxCount`"),
            ("gallery.pick", Params, json!(["photo"]),
             "$: expected a JSON object, got an array"),
            ("gallery.pick", Event, json!({"kind": "nope"}), EVENT_NOT_DEFINED),
            ("gallery.pick", Params, json!({}), "$: missing field `mediaTypes`"),
        ];
        for (cap, kind, value, want) in cases {
            let got = validate_payload(cap, 1, kind, &value).unwrap_err();
            assert_eq!(got, want, "{cap} {kind:?} {value}");
        }
        assert_eq!(
            validate_payload("gallery.pick", 9, PayloadKind::Params, &json!({})).unwrap_err(),
            "$: gallery.pick@9 is not a registry revision"
        );
        // Hostile values and keys cannot bloat a detail.
        let huge = "A".repeat(100_000);
        for value in [
            json!({"mediaTypes": ["photo"], "maxCount": huge}),
            json!({"mediaTypes": [huge], "maxCount": 1}),
        ] {
            let got = validate_payload("gallery.pick", 1, PayloadKind::Params, &value).unwrap_err();
            assert!(got.chars().count() <= 301, "{} chars", got.chars().count());
            assert!(got.starts_with("$.m"), "{got}");
        }
        let mut odd = serde_json::Map::new();
        odd.insert(huge.clone(), json!(0.5));
        let got = validate_payload(
            "permission.query",
            1,
            PayloadKind::Params,
            &Value::Object(odd),
        )
        .unwrap_err();
        assert!(got.chars().count() < 200, "{got}");
        assert!(
            got.ends_with("]: numbers are integers within 2^53 - 1"),
            "{got}"
        );
        // The blob-start fit rule names its field too.
        let bs = BlobStart {
            kind: BlobStartKind::BlobStart,
            channel: 0,
            content_type: "video/mp4".into(),
            bytes: None,
        };
        assert_eq!(
            validate_blob_start_for_request("camera.capture", 1, &json!({"mode": "photo"}), &bs)
                .unwrap_err(),
            "$.contentType: contentType does not fit the requested capture mode"
        );
        // validate_request carries the path-named refusal as its reason.
        let req: DeviceRequest = serde_json::from_value(json!({
            "id": 1, "capability": "gallery.pick", "version": 1,
            "owner": {"moduleInstanceId": "m", "activationId": 1}, "lifetime": "activation",
            "timeoutMs": 1000, "initialCredit": 0,
            "params": {"mediaTypes": ["photo"], "maxCount": 99}
        }))
        .unwrap();
        let rej = validate_request(&req).unwrap_err();
        assert_eq!(rej.code, DeviceErrorCode::InvalidParams);
        assert_eq!(
            rej.reason,
            "params $.maxCount: maxCount 99 out of bounds 1..=16"
        );
    }

    fn roundtrip(v: &Value) -> DeviceMessage {
        let text = serde_json::to_string(v).unwrap();
        let msg = DeviceMessage::decode(&text).expect("decode");
        let back = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(v, &back, "wire JSON must round-trip byte-for-byte");
        msg
    }

    fn rejects(text: &str) {
        assert!(DeviceMessage::decode(text).is_err(), "must reject: {text}");
    }

    #[test]
    fn request_roundtrip_matches_rfc_example() {
        let v = json!({
            "type": "deviceRequest", "id": 17, "capability": "gallery.pick",
            "version": 1,
            "owner": {"moduleInstanceId": "profile-7", "activationId": 3},
            "lifetime": "activation", "timeoutMs": 300000, "initialCredit": 65536,
            "params": {"mediaTypes": ["photo"], "maxCount": 1}
        });
        let msg = roundtrip(&v);
        let DeviceMessage::DeviceRequest(req) = msg else {
            panic!("wrong variant")
        };
        assert!(req.owner.matches(req.lifetime));
        assert!(validate_payload("gallery.pick", 1, PayloadKind::Params, &req.params).is_ok());
        let params: GalleryPickParams = serde_json::from_value(req.params).unwrap();
        assert_eq!(params.max_count, 1);
    }

    #[test]
    fn response_xor_rule() {
        let ok = DeviceResponse {
            id: 1,
            result: Some(json!({})),
            error: None,
            simulated: false,
        };
        assert!(ok.validate().is_ok());
        let both = DeviceResponse {
            id: 1,
            result: Some(json!({})),
            error: Some(DeviceError {
                code: DeviceErrorCode::Denied,
                platform_detail: None,
            }),
            simulated: false,
        };
        assert!(both.validate().is_err());
        let neither = DeviceResponse {
            id: 1,
            result: None,
            error: None,
            simulated: false,
        };
        assert!(neither.validate().is_err());
        let not_object = DeviceResponse {
            id: 1,
            result: Some(json!(5)),
            error: None,
            simulated: false,
        };
        assert!(not_object.validate().is_err());
    }

    #[test]
    fn simulated_flag_is_omitted_when_false_and_kept_when_true() {
        let v = json!({"type":"deviceResponse","id":9,"result":{},"simulated":true});
        let msg = roundtrip(&v);
        let DeviceMessage::DeviceResponse(r) = msg else {
            panic!()
        };
        assert!(r.simulated);
        let plain = serde_json::to_value(DeviceMessage::DeviceResponse(DeviceResponse {
            id: 9,
            result: Some(json!({})),
            error: None,
            simulated: false,
        }))
        .unwrap();
        assert!(plain.get("simulated").is_none());
        rejects(r#"{"type":"deviceResponse","id":9,"result":{},"simulated":false}"#);
        rejects(r#"{"type":"deviceResponse","id":9,"result":{},"simulated":null}"#);
    }

    #[test]
    fn controls_roundtrip_and_strictness() {
        for (raw, expect) in [
            (json!({"grant": 65536u64}), Control::Grant { grant: 65536 }),
            (json!({"cancel": true}), Control::Cancel { cancel: true }),
            (
                json!({"renewLease": 1u64}),
                Control::RenewLease { renew_lease: 1 },
            ),
            (
                json!({"leaseAck": 1u64}),
                Control::LeaseAck { lease_ack: 1 },
            ),
            (
                json!({"renewLease": 4294967295u64}),
                Control::RenewLease {
                    renew_lease: u32::MAX,
                },
            ),
            (json!({"paused": true}), Control::Paused { paused: true }),
            (json!({"paused": false}), Control::Paused { paused: false }),
        ] {
            assert!(Control::validate_value(&raw).is_ok(), "{raw}");
            let c: Control = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(c, expect);
            assert_eq!(serde_json::to_value(&c).unwrap(), raw);
        }
        for bad in [
            r#"{"grant":1,"cancel":true}"#,
            r#"{"grant":5,"cancel":null}"#,
            r#"{}"#,
            r#"{"nuke":true}"#,
            r#"{"Grant":5}"#,
            r#"{"cancel":false}"#,
            r#"{"grant":0}"#,
            r#"{"grant":"lots"}"#,
            r#"{"grant":18446744073709551615}"#,
            r#"{"renewLease":0}"#,
            r#"{"leaseAck":0}"#,
            r#"{"renewLease":9007199254740993}"#,
            r#"{"renewLease":4294967296}"#,
            r#"{"leaseAck":4294967296}"#,
            r#"{"paused":null}"#,
            r#"{"grant":1,"grant":2}"#,
        ] {
            assert!(serde_json::from_str::<Control>(bad).is_err(), "{bad}");
        }
        let ev = DeviceEvent {
            id: 5,
            event: Some(json!({"kind":"progress","state":"running"})),
            control: Some(Control::Cancel { cancel: true }),
        };
        assert!(ev.validate().is_err());
        let constructed = DeviceEvent {
            id: 5,
            event: None,
            control: Some(Control::Cancel { cancel: false }),
        };
        assert!(constructed.validate().is_err());
    }

    #[test]
    fn owner_decoding_is_exact_and_never_downgrades() {
        let act = Owner::Activation {
            module_instance_id: "m1".into(),
            activation_id: 3,
        };
        let module = Owner::Module {
            module_instance_id: "m1".into(),
        };
        let conn = Owner::Connection { connection: true };
        assert!(act.matches(Lifetime::Activation));
        assert!(!act.matches(Lifetime::Background));
        assert!(module.matches(Lifetime::Background));
        assert!(!module.matches(Lifetime::Connection));
        assert!(conn.matches(Lifetime::Connection));
        assert!(!Owner::Connection { connection: false }.matches(Lifetime::Connection));

        let o: Owner =
            serde_json::from_str(r#"{"moduleInstanceId":"x","activationId":1}"#).unwrap();
        assert_eq!(
            o,
            Owner::Activation {
                module_instance_id: "x".into(),
                activation_id: 1
            }
        );
        let o: Owner = serde_json::from_str(r#"{"moduleInstanceId":"x"}"#).unwrap();
        assert!(matches!(o, Owner::Module { .. }));
        let o: Owner = serde_json::from_str(r#"{"connection":true}"#).unwrap();
        assert!(matches!(o, Owner::Connection { connection: true }));

        for bad in [
            r#"{"moduleInstanceId":"x","activationId":-1}"#,
            r#"{"moduleInstanceId":"x","activationId":"3"}"#,
            r#"{"moduleInstanceId":"x","activationId":0}"#,
            r#"{"moduleInstanceId":"x","activationId":4294967296}"#,
            r#"{"moduleInstanceId":"x","activationId":null}"#,
            r#"{"moduleInstanceId":"x","activationId":1,"extra":1}"#,
            r#"{"moduleInstanceId":"x","connection":true}"#,
            r#"{"connection":false}"#,
            r#"{"connection":true,"moduleInstanceId":null}"#,
            r#"{"moduleInstanceId":""}"#,
            r#"{"ModuleInstanceId":"x"}"#,
            r#"{"moduleInstanceId":"x","moduleInstanceId":"y"}"#,
            r#"{}"#,
        ] {
            assert!(serde_json::from_str::<Owner>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn strict_decoding_rejects_what_the_schema_rejects() {
        let good = r#"{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,
            "owner":{"moduleInstanceId":"p","activationId":1},"lifetime":"activation",
            "timeoutMs":1000,"initialCredit":0,"params":{}}"#;
        assert!(DeviceMessage::decode(good).is_ok());
        for bad in [
            // duplicate keys at top level and nested inside params
            good.replace(r#""id":1,"#, r#""id":1,"id":2,"#),
            good.replace(r#""params":{}"#, r#""params":{"a":1,"a":2}"#),
            good.replace(
                r#""type":"deviceRequest","#,
                r#""type":"deviceRequest","type":"deviceEvent","#,
            ),
            // -0 is a float to serde_json: rejected for integer fields
            good.replace(r#""id":1,"#, r#""id":-0,"#),
            good.replace(r#""id":1,"#, r#""id":0,"#),
            good.replace(r#""id":1,"#, r#""id":4294967296,"#),
            good.replace(r#""id":1,"#, r#""ID":1,"#),
            good.replace(r#""version":1,"#, r#""version":0,"#),
            good.replace(r#""timeoutMs":1000"#, r#""timeoutMs":0"#),
            good.replace(r#""timeoutMs":1000"#, r#""timeoutMs":86400001"#),
            good.replace(r#""initialCredit":0"#, r#""initialCredit":4194305"#),
            good.replace(r#""initialCredit":0"#, r#""initialCredit":null"#),
            good.replace(r#""params":{}"#, r#""params":5"#),
            good.replace(r#""params":{}"#, r#""params":null"#),
            good.replace(r#""lifetime":"activation""#, r#""lifetime":"background""#),
        ] {
            rejects(&bad);
        }
        rejects(r#"{"type":"deviceResponse","id":1,"result":null,"error":{"code":"denied"}}"#);
        rejects(r#"{"type":"deviceResponse","id":1,"result":5}"#);
        rejects(
            r#"{"type":"deviceResponse","id":1,"error":{"code":"denied","platformDetail":null}}"#,
        );
        rejects(r#"{"type":"deviceEvent","id":1,"event":null,"control":{"cancel":true}}"#);
        rejects(r#"{"type":"deviceEvent","id":1,"event":[]}"#);
        // platformDetail "" is present and round-trips as present.
        roundtrip(
            &json!({"type":"deviceResponse","id":1,"error":{"code":"denied","platformDetail":""}}),
        );
        // maxLength counts code points: 512 astral characters fit, 513 do not.
        let astral = |n: usize| "\u{1F600}".repeat(n);
        roundtrip(&json!({"type":"deviceResponse","id":1,
            "error":{"code":"internal","platformDetail": astral(512)}}));
        rejects(
            &json!({"type":"deviceResponse","id":1,
                "error":{"code":"internal","platformDetail": astral(513)}})
            .to_string(),
        );
    }

    #[test]
    fn blob_start_verifies_its_kind_and_is_closed() {
        let bs: BlobStart = serde_json::from_str(
            r#"{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":120000}"#,
        )
        .unwrap();
        assert_eq!(bs.bytes, Some(120_000));
        // `bytes` is optional (RFC 001 §2.4): an undeclared live item.
        let live: BlobStart =
            serde_json::from_str(r#"{"kind":"blobStart","channel":0,"contentType":"audio/L16"}"#)
                .unwrap();
        assert_eq!(live.bytes, None);
        assert!(serde_json::to_value(&live).unwrap().get("bytes").is_none());
        assert_eq!(
            serde_json::to_value(&bs).unwrap()["kind"],
            json!("blobStart")
        );
        for bad in [
            r#"{"kind":"blobStrat","channel":0,"contentType":"a","bytes":1}"#,
            r#"{"channel":0,"contentType":"a","bytes":1}"#,
            r#"{"kind":"blobStart","channel":0,"contentType":"a","bytes":1,"x":1}"#,
            r#"{"kind":"blobStart","channel":0,"contentType":"a","bytes":null}"#,
        ] {
            assert!(serde_json::from_str::<BlobStart>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn payload_validation_applies_revision_bounds() {
        let ok = |c: &str, k: PayloadKind, v: Value| {
            validate_payload(c, 1, k, &v).unwrap_or_else(|e| panic!("{c} {v}: {e}"))
        };
        let bad = |c: &str, k: PayloadKind, v: Value| {
            assert!(
                validate_payload(c, 1, k, &v).is_err(),
                "{c} must reject {v}"
            )
        };
        let sha = "5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347";
        use PayloadKind::*;
        ok(
            "gallery.pick",
            Params,
            json!({"mediaTypes":["photo","video"],"maxCount":16}),
        );
        bad(
            "gallery.pick",
            Params,
            json!({"mediaTypes":[],"maxCount":1}),
        );
        bad(
            "gallery.pick",
            Params,
            json!({"mediaTypes":["photo","photo"],"maxCount":1}),
        );
        bad(
            "gallery.pick",
            Params,
            json!({"mediaTypes":["photo"],"maxCount":0}),
        );
        bad(
            "gallery.pick",
            Params,
            json!({"mediaTypes":["photo"],"maxCount":17}),
        );
        let item = |ch: u16, bytes: u64, sha: &str| json!({"channel":ch,"contentType":"image/jpeg","bytes":bytes,"sha256":sha});
        ok(
            "gallery.pick",
            Result,
            json!({"items":[item(0, 17, sha), item(1, 0, sha)]}),
        );
        bad(
            "gallery.pick",
            Result,
            json!({"items":[item(0, 17, sha), item(0, 17, sha)]}),
        );
        bad(
            "gallery.pick",
            Result,
            json!({"items":[item(0, 64 * 1024 * 1024 + 1, sha)]}),
        );
        bad(
            "gallery.pick",
            Result,
            json!({"items":[item(0, 17, "DEADBEEF")]}),
        );
        bad("gallery.pick", Result, json!({"items":[item(16, 17, sha)]}));
        bad("gallery.pick", Result, json!({"bytesWritten":3}));
        ok(
            "gallery.pick",
            Event,
            json!({"kind":"blobStart","channel":0,"contentType":"a","bytes":1}),
        );
        ok(
            "gallery.pick",
            Event,
            json!({"kind":"progress","state":"pendingConsent"}),
        );
        bad(
            "gallery.pick",
            Event,
            json!({"kind":"progress","state":"paused"}),
        );
        bad(
            "permission.query",
            Event,
            json!({"kind":"blobStart","channel":0,"contentType":"a","bytes":1}),
        );
        ok(
            "permission.request",
            Event,
            json!({"kind":"progress","state":"running"}),
        );
        ok(
            "file.save",
            Params,
            json!({"channel":0,"name":"a","contentType":"b","bytes":1,"sha256":sha}),
        );
        bad(
            "file.save",
            Params,
            json!({"channel":9,"name":"a","contentType":"b","bytes":1,"sha256":sha}),
        );
        bad(
            "file.save",
            Params,
            json!({"channel":0,"name":"a","contentType":"b","bytes":0,"sha256":sha}),
        );
        bad(
            "file.save",
            Params,
            json!({"channel":0,"name":"a","contentType":"b","bytes":1,"sha256":""}),
        );
        bad(
            "file.save",
            Params,
            json!({"channel":0,"name":"a","contentType":"b","bytes":1u64 << 40,"sha256":sha}),
        );
        bad(
            "mic.record",
            Params,
            json!({"sampleRate":1,"format":"pcm16"}),
        );
        bad(
            "permission.query",
            Params,
            json!({"permission":"x".repeat(65)}),
        );
        ok(
            "bluetooth.scan",
            Event,
            json!({"device":{"id":"a","name":"","rssi":-40}}),
        );
        bad(
            "bluetooth.scan",
            Event,
            json!({"device":{"id":"a","name":null,"rssi":-40}}),
        );
        bad(
            "core.capabilities",
            Event,
            json!({"capabilities":[{"name":"a","versions":[0,0]}]}),
        );
        bad(
            "core.capabilities",
            Event,
            json!({"capabilities":[{"name":"a","versions":[1]},{"name":"a","versions":[1]}]}),
        );
        assert!(validate_payload("gallery.pick", 2, Params, &json!({})).is_err());
    }

    #[test]
    fn error_codes_serialize_camel_case_and_are_exhaustive() {
        let expected = [
            "unsupported",
            "unavailable",
            "denied",
            "revoked",
            "cancelled",
            "timeout",
            "throttled",
            "connectionLost",
            "invalidParams",
            "internal",
        ];
        assert_eq!(DeviceErrorCode::ALL.len(), expected.len());
        for (code, name) in DeviceErrorCode::ALL.iter().zip(expected) {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(name));
        }
    }

    fn offer(name: &str, versions: &[u32]) -> CapabilityOffer {
        CapabilityOffer {
            name: name.into(),
            versions: versions.to_vec(),
        }
    }

    fn sel(name: &str, version: u32) -> CapabilitySelection {
        CapabilitySelection {
            name: name.into(),
            version,
        }
    }

    #[test]
    fn handshake_selection_picks_highest_common() {
        let hello = DeviceHello {
            protocol_versions: vec![1, 2],
            binary: true,
            capabilities: vec![
                offer("gallery.pick", &[1, 2]),
                offer("core.capabilities", &[1]),
                offer("client.only", &[1]),
            ],
        };
        let server_caps = vec![
            offer("core.capabilities", &[1]),
            offer("gallery.pick", &[1]),
            offer("server.only", &[3]),
        ];
        let ack = select_device_ack(&hello, &[1], &server_caps, true).unwrap();
        assert_eq!(ack.protocol_version, 1);
        assert!(ack.binary);
        assert_eq!(
            ack.capabilities,
            vec![sel("core.capabilities", 1), sel("gallery.pick", 1)]
        );
        // No common protocol version → device access disabled.
        assert!(select_device_ack(&hello, &[9], &server_caps, true).is_none());
        // Binary off: binary-plane revisions are not selectable (rule c).
        let ack = select_device_ack(&hello, &[1], &server_caps, false).unwrap();
        assert!(!ack.binary);
        assert_eq!(ack.capabilities, vec![sel("core.capabilities", 1)]);
    }

    #[test]
    fn handshake_selection_edge_rules() {
        let server = vec![
            offer("core.capabilities", &[1]),
            offer("permission.query", &[1]),
        ];
        let hello = |pv: &[u32], caps: Vec<CapabilityOffer>| DeviceHello {
            protocol_versions: pv.to_vec(),
            binary: true,
            capabilities: caps,
        };
        // (a) version 0 is never selected.
        assert!(select_device_ack(
            &hello(&[0], vec![offer("core.capabilities", &[1])]),
            &[0, 1],
            &server,
            true
        )
        .is_none());
        // A hello listing the reserved 0 is schema-invalid: device disabled.
        assert!(select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("permission.query", &[0]),
                ],
            ),
            &[1],
            &[
                offer("core.capabilities", &[1]),
                offer("permission.query", &[0, 1]),
            ],
            true,
        )
        .is_none());
        // Server-side 0 is filtered: a server offering only 0 yields no
        // selection for that name.
        let ack = select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("permission.query", &[1]),
                ],
            ),
            &[1],
            &[
                offer("core.capabilities", &[1]),
                offer("permission.query", &[0]),
            ],
            true,
        )
        .unwrap();
        assert_eq!(ack.capabilities, vec![sel("core.capabilities", 1)]);
        // (b) core.capabilities@1 missing from the intersection disables device.
        assert!(select_device_ack(
            &hello(&[1], vec![offer("permission.query", &[1])]),
            &[1],
            &server,
            true
        )
        .is_none());
        // (d) duplicates in the hello disable device.
        assert!(select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("core.capabilities", &[1])
                ]
            ),
            &[1],
            &server,
            true
        )
        .is_none());
        assert!(select_device_ack(
            &hello(&[1, 1], vec![offer("core.capabilities", &[1])]),
            &[1],
            &server,
            true
        )
        .is_none());
        assert!(select_device_ack(
            &hello(&[1], vec![offer("core.capabilities", &[1, 1])]),
            &[1],
            &server,
            true
        )
        .is_none());
        // Revisions absent from the registry are never selected.
        let ack = select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("gallery.pick", &[1, 2]),
                ],
            ),
            &[1],
            &[
                offer("core.capabilities", &[1]),
                offer("gallery.pick", &[1, 2]),
            ],
            true,
        )
        .unwrap();
        assert_eq!(ack.capabilities[1], sel("gallery.pick", 1));
    }

    #[test]
    fn frame_header_reference_codec() {
        let h = FrameHeader {
            version: 1,
            flags: 0,
            channel: 2,
            request_id: 17,
            seq: 3,
        };
        let bytes = h.encode();
        assert_eq!(bytes.len(), FRAME_HEADER_LEN);
        // Golden bytes: little-endian, documented layout.
        assert_eq!(bytes, [1, 0, 2, 0, 17, 0, 0, 0, 3, 0, 0, 0]);
        let mut framed = bytes.to_vec();
        framed.extend_from_slice(b"payload");
        let (back, payload) = FrameHeader::decode(&framed).unwrap();
        assert_eq!(back, h);
        assert_eq!(payload, b"payload");

        assert_eq!(
            FrameHeader::decode(&bytes[..11]),
            Err(FrameError::ShortHeader)
        );
        let mut bad_version = bytes;
        bad_version[0] = 9;
        assert_eq!(
            FrameHeader::decode(&bad_version).map(|(h, _)| h),
            Err(FrameError::Violation)
        );
        let mut bad_flags = h.encode();
        bad_flags[1] = 1;
        assert_eq!(
            FrameHeader::decode(&bad_flags).map(|(h, _)| h),
            Err(FrameError::Violation)
        );
    }

    #[test]
    fn registry_completeness_tripwire() {
        let regs = registry();
        assert!(!regs.is_empty());
        let mut names: Vec<&str> = regs.iter().map(|c| c.name).collect();
        assert!(all_unique(&names), "duplicate capability names");
        assert_eq!(names[0], CORE_CAPABILITIES);
        // core.* first, then alphabetical.
        names.retain(|n| !n.starts_with("core."));
        let mut alpha = names.clone();
        alpha.sort_unstable();
        assert_eq!(names, alpha, "registry must stay alphabetical");

        for cap in regs {
            assert!(!cap.revisions.is_empty(), "{}: no revisions", cap.name);
            let mut prev = 0;
            for rev in cap.revisions {
                assert!(rev.version > prev, "{}: versions not ascending", cap.name);
                prev = rev.version;
                assert!(!rev.lifetimes.is_empty(), "{}: no lifetimes", cap.name);
                assert!(rev.max_timeout_ms > 0, "{}: zero max timeout", cap.name);
                assert!(rev.max_initial_credit <= rev.max_outstanding_credit);
                if rev.data == DataPlane::BinaryDownload {
                    assert_eq!(
                        rev.max_initial_credit, 0,
                        "{}: server→client initialCredit MUST be zero",
                        cap.name
                    );
                }
                if rev.data.is_binary() {
                    assert!(
                        rev.max_item_bytes > 0,
                        "{}: blob cap without item cap",
                        cap.name
                    );
                    assert!(
                        rev.max_items > 0,
                        "{}: blob cap without item count",
                        cap.name
                    );
                    assert!(
                        rev.max_outstanding_credit > 0,
                        "{}: binary plane without credit bound",
                        cap.name
                    );
                }
                if cap.name.starts_with("core.") {
                    assert_eq!(rev.lifetimes, CONNECTION_ONLY);
                    assert_eq!(rev.consent, Consent::None);
                } else {
                    assert!(
                        !rev.lifetimes.contains(&Lifetime::Connection),
                        "{}: app capability may not detach from its module",
                        cap.name
                    );
                }
            }
        }
        assert!(find_revision("gallery.pick", 1).is_some());
        assert!(find_revision("gallery.pick", 2).is_none());
        assert!(find_revision("nope", 1).is_none());
        assert_eq!(registry_max_timeout_ms(), 86_400_000);
        assert_eq!(registry_max_initial_credit(), 4 * MIB);
        assert_eq!(registry_max_outstanding_credit(), 8 * MIB);
        assert_eq!(registry_max_item_bytes(), 64 * MIB);
    }

    #[test]
    fn hello_ack_shapes_match_rfc() {
        let hello: DeviceHello = serde_json::from_value(json!({
            "protocolVersions":[1],"binary":true,
            "capabilities":[{"name":"core.capabilities","versions":[1]},
                            {"name":"gallery.pick","versions":[1,2]}]
        }))
        .unwrap();
        assert_eq!(hello.protocol_versions, vec![1]);
        assert!(hello.validate().is_ok());
        let ack: DeviceAck = serde_json::from_value(json!({
            "protocolVersion":1,"binary":true,
            "capabilities":[{"name":"core.capabilities","version":1},
                            {"name":"gallery.pick","version":1}]
        }))
        .unwrap();
        assert_eq!(ack.capabilities[1].version, 1);
        assert!(ack.validate().is_ok());
        let dup = DeviceHello {
            protocol_versions: vec![1],
            binary: true,
            capabilities: vec![offer("a", &[1]), offer("a", &[2])],
        };
        assert!(dup.validate().is_err());
    }

    fn event_text(inner: &str) -> String {
        format!(r#"{{"type":"deviceEvent","id":1,"event":{inner}}}"#)
    }

    #[test]
    fn json_limits_numbers_are_integer_tokens_within_2_53() {
        let ok = |inner: &str| {
            DeviceMessage::decode(&event_text(inner))
                .unwrap_or_else(|e| panic!("{inner} must decode: {e}"))
        };
        ok(r#"{"a":9007199254740991}"#);
        ok(r#"{"a":-9007199254740991}"#);
        ok(r#"{"a":0,"b":-1,"c":[1,2,3]}"#);
        for bad in [
            r#"{"a":1.0}"#,
            r#"{"a":1e0}"#,
            r#"{"a":1E0}"#,
            r#"{"a":1e400}"#,
            r#"{"a":-0}"#,
            r#"{"a":-0.0}"#,
            r#"{"a":0.5}"#,
            r#"{"a":9007199254740992}"#,
            r#"{"a":-9007199254740992}"#,
            r#"{"a":12345678901234567}"#,
            r#"{"a":123456789012345678901234567890}"#,
            r#"{"a":01}"#,
            r#"{"a":+1}"#,
            r#"{"a":NaN}"#,
            r#"{"a":Infinity}"#,
            r#"{"a":-Infinity}"#,
            r#"{"a":True}"#,
            r#"{"a":Null}"#,
            r#"{"a":abc}"#,
            r#"{"a":undefined}"#,
        ] {
            rejects(&event_text(bad));
        }
        // Typed fields too.
        rejects(r#"{"type":"deviceEvent","id":1.0,"control":{"cancel":true}}"#);
        rejects(r#"{"type":"deviceEvent","id":1e0,"control":{"cancel":true}}"#);
        rejects(r#"{"type":"deviceEvent","id":1,"control":{"grant":1E0}}"#);
    }

    #[test]
    fn json_limits_depth_32_containers() {
        // The envelope is depth 1 and `event` depth 2: 30 more arrays is 32.
        let nest = |n: usize| format!("{{\"a\":{}{}}}", "[".repeat(n), "]".repeat(n));
        assert!(DeviceMessage::decode(&event_text(&nest(30))).is_ok());
        rejects(&event_text(&nest(31)));
        let v: Value = serde_json::from_str(&event_text(&nest(31))).unwrap();
        assert!(DeviceMessage::decode_value(&v).is_err());
        assert!(check_json_value(&serde_json::from_str::<Value>(&nest(31)).unwrap()).is_ok());
        assert!(check_json_value(&serde_json::from_str::<Value>(&nest(32)).unwrap()).is_err());
        // Far past serde's own limit: still a clean error.
        rejects(&event_text(&nest(5000)));
    }

    #[test]
    fn json_limits_strings_keys_and_encoding() {
        for bad in [
            "{\"a\u{1}\":1}",
            "{\"a\":\"x\u{1f}\"}",
            "{\"a\":\"tab\there\"}",
            "{\"a\":\"nl\nhere\"}",
            r#"{"\ud800":1}"#,
            r#"{"a":"\ud800"}"#,
            r#"{"a":"\udc00x"}"#,
            r#"{"a":"\udc00\ud800"}"#,
            r#"{"a":"\x"}"#,
        ] {
            rejects(&event_text(bad));
        }
        rejects("{\"type\":\"deviceEvent\",\"id\":1,\"control\":{\"cancel\":true}}\u{feff}");
        rejects("\u{feff}{\"type\":\"deviceEvent\",\"id\":1,\"control\":{\"cancel\":true}}");
        rejects(r#"{"type":"deviceEvent","id":1,"control":{"cancel":true}} x"#);
        // Escaped keys collide after unescaping.
        rejects(r#"{"type":"deviceEvent","id":1,"\u0069d":2,"control":{"cancel":true}}"#);
        rejects(&event_text(r#"{"k":1,"\u006b":2}"#));
        // A valid surrogate pair and escaped characters are fine.
        assert!(DeviceMessage::decode(&event_text(
            r#"{"a":"\ud83d\ude00 \u00e9 \/ \b\f\n\r\t \\ \"","\u0062":1}"#
        ))
        .is_ok());
        // Invalid UTF-8 bytes, in a value and in a key.
        let mut bytes = event_text(r#"{"a":"xy"}"#).into_bytes();
        let pos = bytes.iter().position(|&b| b == b'x').unwrap();
        bytes[pos] = 0xff;
        assert!(DeviceMessage::decode_bytes(&bytes).is_err());
        let mut bytes = event_text(r#"{"ab":1}"#).into_bytes();
        let pos = bytes.iter().position(|&b| b == b'b').unwrap();
        bytes[pos] = 0xc0;
        assert!(DeviceMessage::decode_bytes(&bytes).is_err());
        assert!(DeviceMessage::decode_bytes(event_text("{}").as_bytes()).is_ok());
    }

    #[test]
    fn json_limits_message_size_checked_before_parsing() {
        let head = r#"{"type":"deviceEvent","id":1,"control":{"cancel":true}"#;
        let exact = format!(
            "{head}{}}}",
            " ".repeat(limits::MESSAGE_MAX_BYTES - head.len() - 1)
        );
        assert_eq!(exact.len(), limits::MESSAGE_MAX_BYTES);
        assert!(DeviceMessage::decode(&exact).is_ok());
        let over = format!(
            "{head}{}}}",
            " ".repeat(limits::MESSAGE_MAX_BYTES - head.len())
        );
        assert!(matches!(
            DeviceMessage::decode(&over),
            Err(WireError::Invalid(_))
        ));
        // Not even valid JSON: the size check still fires first.
        let junk = "x".repeat(limits::MESSAGE_MAX_BYTES + 1);
        assert!(matches!(
            DeviceMessage::decode(&junk),
            Err(WireError::Invalid(_))
        ));
        assert!(matches!(
            DeviceMessage::decode_bytes(junk.as_bytes()),
            Err(WireError::Invalid(_))
        ));
    }

    #[test]
    fn arrays_for_objects_and_maps_for_enums_are_rejected() {
        for bad in [
            r#"{"type":"deviceResponse","id":1,"error":["denied"]}"#,
            r#"{"type":"deviceResponse","id":1,"error":["denied","detail"]}"#,
            r#"{"type":"deviceResponse","id":1,"error":{"code":{"denied":null}}}"#,
            r#"{"type":"deviceEvent","id":1,"control":[65536]}"#,
            r#"{"type":"deviceEvent","id":1,"control":{"grant":[1]}}"#,
            r#"{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,
                "owner":{"moduleInstanceId":"p","activationId":1},"lifetime":{"activation":null},
                "timeoutMs":1000,"initialCredit":0,"params":{}}"#,
            r#"{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,
                "owner":["p",1],"lifetime":"activation",
                "timeoutMs":1000,"initialCredit":0,"params":{}}"#,
            r#"["deviceEvent",1,null,{"cancel":true}]"#,
            r#"null"#,
            r#"[]"#,
        ] {
            rejects(bad);
        }
        let sha = "5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347";
        use PayloadKind::*;
        for (cap, kind, v) in [
            (
                "gallery.pick",
                Result,
                json!({"items":[[0,"image/jpeg",3,sha]]}),
            ),
            (
                "mic.record",
                Result,
                json!({"durationMs":5,"item":[0,"audio/wav",3,sha]}),
            ),
            ("file.pick", Result, json!({"items":[[0,"a","b",3,sha]]})),
            (
                "bluetooth.scan",
                Event,
                json!({"device":["dev1","name",-40]}),
            ),
            (
                "core.capabilities",
                Event,
                json!({"capabilities":[["gallery.pick",[1]]]}),
            ),
            (
                "gallery.pick",
                Params,
                json!({"mediaTypes":[{"photo":null}],"maxCount":1}),
            ),
            (
                "permission.query",
                Result,
                json!({"status":{"granted":null}}),
            ),
            (
                "mic.record",
                Params,
                json!({"sampleRate":8000,"format":{"pcm16":null}}),
            ),
            (
                "gallery.pick",
                Event,
                json!({"kind":"progress","state":{"running":null}}),
            ),
            ("permission.query", Params, json!(["photo"])),
            ("bluetooth.scan", Params, json!([])),
            (
                "gallery.pick",
                Event,
                json!({"kind":"blobStart","channel":0,"contentType":"a","bytes":1.0}),
            ),
        ] {
            assert!(
                validate_payload(cap, 1, kind, &v).is_err(),
                "{cap} {kind:?} {v}"
            );
        }
        let hello = json!([[1], true, [["core.capabilities", [1]]]]);
        assert!(DeviceHello::from_value(&hello).is_err());
    }

    #[test]
    fn handshake_decoders_are_strict_and_reject_duplicate_names() {
        let hello = r#"{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}"#;
        assert!(DeviceHello::decode(hello).is_ok());
        for bad in [
            r#"{"protocolVersions":[1],"binary":false,"binary":true,"capabilities":[]}"#,
            r#"{"protocolVersions":[1.0],"binary":true,"capabilities":[]}"#,
            r#"{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"a","versions":[1]},{"name":"a","versions":[2]}]}"#,
            r#"{"protocolVersions":[0],"binary":true,"capabilities":[]}"#,
            r#"{"protocolVersions":[1],"binary":true,"capabilities":[],"x":1}"#,
        ] {
            assert!(DeviceHello::decode(bad).is_err(), "{bad}");
        }
        // Canonically equivalent names are distinct names (code points).
        let nfc_nfd = r#"{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"\u00e9","versions":[1]},{"name":"e\u0301","versions":[1]}]}"#;
        assert!(DeviceHello::decode(nfc_nfd).is_ok());
        assert!(DeviceAck::decode(r#"{"protocolVersion":1,"binary":true,"capabilities":[{"name":"a","version":1},{"name":"a","version":2}]}"#).is_err());
        assert!(DeviceAck::decode(
            r#"{"protocolVersion":1,"binary":true,"capabilities":[{"name":"a","version":1}]}"#
        )
        .is_ok());
        assert!(CapabilitiesEvent::decode(
            r#"{"capabilities":[{"name":"a","versions":[1]},{"name":"a","versions":[1]}]}"#
        )
        .is_err());
        assert!(CapabilitiesEvent::decode(r#"{"capabilities":[]}"#).is_ok());
    }

    #[test]
    fn selection_validates_the_hello_first_and_first_server_entry_wins() {
        let hello = |pv: &[u32], caps: Vec<CapabilityOffer>| DeviceHello {
            protocol_versions: pv.to_vec(),
            binary: true,
            capabilities: caps,
        };
        let server = vec![
            offer("core.capabilities", &[1]),
            offer("permission.query", &[1]),
        ];
        // A schema-invalid hello (reserved 0) disables device access.
        assert!(select_device_ack(
            &hello(&[0, 1], vec![offer("core.capabilities", &[1])]),
            &[1],
            &server,
            true
        )
        .is_none());
        assert!(select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("permission.query", &[0])
                ]
            ),
            &[1],
            &server,
            true
        )
        .is_none());
        // Too many protocol versions (> 8) is schema-invalid too.
        assert!(select_device_ack(
            &hello(
                &[1, 2, 3, 4, 5, 6, 7, 8, 9],
                vec![offer("core.capabilities", &[1])]
            ),
            &[1],
            &server,
            true
        )
        .is_none());
        // Server duplicates: first entry wins, never merged.
        let dup_server = vec![
            offer("core.capabilities", &[1]),
            offer("permission.query", &[2]),
            offer("permission.query", &[1]),
        ];
        let ack = select_device_ack(
            &hello(
                &[1],
                vec![
                    offer("core.capabilities", &[1]),
                    offer("permission.query", &[1]),
                ],
            ),
            &[1],
            &dup_server,
            true,
        )
        .unwrap();
        assert_eq!(ack.capabilities, vec![sel("core.capabilities", 1)]);
        // Server-side reserved 0 is filtered, never selected.
        let ack = select_device_ack(
            &hello(&[1], vec![offer("core.capabilities", &[1])]),
            &[0, 1],
            &[offer("core.capabilities", &[0, 1])],
            true,
        )
        .unwrap();
        assert_eq!(ack.protocol_version, 1);
        assert_eq!(ack.capabilities, vec![sel("core.capabilities", 1)]);
    }

    #[test]
    fn request_admission_per_revision() {
        let req = |cap: &str,
                   version: u32,
                   lifetime: Lifetime,
                   timeout: u64,
                   credit: u64,
                   params: Value| DeviceRequest {
            id: 1,
            capability: cap.into(),
            version,
            owner: Owner::Activation {
                module_instance_id: "m".into(),
                activation_id: 1,
            },
            lifetime,
            timeout_ms: timeout,
            initial_credit: credit,
            params,
        };
        let gp = json!({"mediaTypes":["photo"],"maxCount":1});
        assert!(validate_request(&req(
            "gallery.pick",
            1,
            Lifetime::Activation,
            1000,
            0,
            gp.clone()
        ))
        .is_ok());
        let code = |r: DeviceRequest| validate_request(&r).unwrap_err().code;
        assert_eq!(
            code(req(
                "gallery.pick",
                2,
                Lifetime::Activation,
                1000,
                0,
                gp.clone()
            )),
            DeviceErrorCode::Unsupported
        );
        assert_eq!(
            code(req("nope", 1, Lifetime::Activation, 1000, 0, gp.clone())),
            DeviceErrorCode::Unsupported
        );
        assert_eq!(
            code(req(
                "gallery.pick",
                1,
                Lifetime::Background,
                1000,
                0,
                gp.clone()
            )),
            DeviceErrorCode::InvalidParams
        );
        assert_eq!(
            code(req(
                "gallery.pick",
                1,
                Lifetime::Activation,
                300_001,
                0,
                gp.clone()
            )),
            DeviceErrorCode::InvalidParams
        );
        assert_eq!(
            code(req(
                "gallery.pick",
                1,
                Lifetime::Activation,
                1000,
                4 * MIB + 1,
                gp
            )),
            DeviceErrorCode::InvalidParams
        );
        assert_eq!(
            code(req(
                "gallery.pick",
                1,
                Lifetime::Activation,
                1000,
                0,
                json!({})
            )),
            DeviceErrorCode::InvalidParams
        );
        let fs = json!({"channel":0,"name":"a","contentType":"b","bytes":1,
            "sha256":"5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347"});
        assert_eq!(
            code(req("file.save", 1, Lifetime::Activation, 1000, 1, fs)),
            DeviceErrorCode::InvalidParams
        );
    }

    #[test]
    fn mic_record_max_duration_is_optional_and_bounded() {
        use PayloadKind::Params;
        let ok = |v: Value| assert!(validate_payload("mic.record", 1, Params, &v).is_ok(), "{v}");
        let bad = |v: Value| {
            assert!(
                validate_payload("mic.record", 1, Params, &v).is_err(),
                "{v}"
            )
        };
        ok(json!({"sampleRate":16000,"format":"pcm16"}));
        ok(json!({"sampleRate":16000,"format":"pcm16","maxDurationMs":1}));
        ok(json!({"sampleRate":16000,"format":"pcm16","maxDurationMs":600000}));
        bad(json!({"sampleRate":16000,"format":"pcm16","maxDurationMs":0}));
        bad(json!({"sampleRate":16000,"format":"pcm16","maxDurationMs":600001}));
        bad(json!({"sampleRate":16000,"format":"pcm16","maxDurationMs":null}));
        // blobStart without a size is valid on every upload revision.
        for cap in ["mic.record", "gallery.pick", "file.pick"] {
            let ev = json!({"kind":"blobStart","channel":0,"contentType":"a"});
            assert!(
                validate_payload(cap, 1, PayloadKind::Event, &ev).is_ok(),
                "{cap}"
            );
        }
    }

    #[test]
    fn lossless_sequence_up_to_u32_max_and_no_wrap() {
        let mut t = ChannelSeq {
            expected: u64::from(u32::MAX) - 1,
        };
        assert!(t.accept(Overflow::Pause, u32::MAX - 1));
        assert!(t.accept(Overflow::Pause, u32::MAX));
        // Nothing follows u32::MAX: 0 would be a wrap, anything else a decrease.
        assert!(!t.accept(Overflow::Pause, 0));
        assert!(!t.accept(Overflow::Pause, u32::MAX));
        assert!(!t.accept(Overflow::DropOldest, u32::MAX));
    }

    /// Every JSON-events revision has a `decode_event` arm: adding e.g.
    /// `bluetooth.scan@2` to the registry without one fails here instead of
    /// silently rejecting all of its events.
    #[test]
    fn decode_event_covers_every_json_events_revision() {
        for cap in registry() {
            for rev in cap.revisions {
                if rev.data == DataPlane::JsonEvents {
                    let err = decode_event(cap.name, rev.version, &json!({})).unwrap_err();
                    assert_ne!(err, EVENT_NOT_DEFINED, "{}@{}", cap.name, rev.version);
                }
            }
        }
    }

    #[test]
    fn invalid_messages_are_attributed_only_by_a_clean_type_and_id() {
        let at = |t: &str| attribute_invalid(&serde_json::from_str::<Value>(t).unwrap());
        assert_eq!(
            at(r#"{"type":"deviceEvent","id":7,"control":{"cancel":false}}"#),
            Some((MessageKind::Event, 7))
        );
        assert_eq!(
            at(r#"{"type":"deviceRequest","id":4294967295,"x":1}"#),
            Some((MessageKind::Request, u32::MAX))
        );
        for t in [
            r#"{"type":"deviceEvent","id":0}"#,
            r#"{"type":"deviceEvent","id":4294967296}"#,
            r#"{"type":"deviceEvent","id":"7"}"#,
            r#"{"type":"deviceEvent"}"#,
            r#"{"type":"hello","id":7}"#,
            r#"{"id":7}"#,
            r#"[7]"#,
        ] {
            assert_eq!(at(t), None, "{t}");
        }
    }

    /// P1: `permission.query@1` / `permission.request@1` take the closed
    /// `Permission` enum; any other name (typo, alias, wrong case, former
    /// free-form value) is `invalidParams` at decode.
    #[test]
    fn permission_names_are_a_closed_enum() {
        use PayloadKind::Params;
        let names: Vec<&str> = Permission::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(
            names,
            [
                "camera",
                "microphone",
                "photos",
                "location",
                "notifications",
                "bluetooth",
                "contacts"
            ]
        );
        for p in Permission::ALL {
            // serde spelling == as_str (the schema enum is built from as_str).
            assert_eq!(serde_json::to_value(p).unwrap(), json!(p.as_str()));
            for cap in ["permission.query", "permission.request"] {
                let v = json!({"permission": p.as_str()});
                assert!(validate_payload(cap, 1, Params, &v).is_ok(), "{cap} {v}");
            }
        }
        for bad in [
            json!({"permission":"camra"}),
            json!({"permission":"geolocation"}),
            json!({"permission":"Camera"}),
            json!({"permission":"CAMERA"}),
            json!({"permission":""}),
            json!({"permission":"x"}),
            json!({"permission":"camera "}),
            json!({"permission":1}),
            json!({"permission":null}),
            json!({"permission":{"camera":null}}),
            json!({"permission":["camera"]}),
            json!({"permission":"camera","extra":1}),
            json!({}),
        ] {
            for cap in ["permission.query", "permission.request"] {
                assert!(
                    validate_payload(cap, 1, Params, &bad).is_err(),
                    "{cap} must reject {bad}"
                );
            }
        }
    }

    /// C2: `camera.capture@1` registry entry, params and result rules.
    #[test]
    fn camera_capture_revision_and_payloads() {
        let rev = find_revision("camera.capture", 1).expect("camera.capture@1");
        assert_eq!(rev.mode, Mode::Unary);
        assert_eq!(rev.data, DataPlane::BinaryUpload);
        assert_eq!(rev.consent, Consent::PerUse);
        assert_eq!(rev.overflow, Overflow::Pause);
        assert_eq!(rev.lifetimes, ACTIVATION_ONLY);
        assert_eq!(rev.max_items, 1);
        assert_eq!(rev.max_item_bytes, 64 * MIB);
        let gallery = find_revision("gallery.pick", 1).unwrap();
        assert_eq!(rev.max_initial_credit, gallery.max_initial_credit);
        assert_eq!(rev.max_outstanding_credit, gallery.max_outstanding_credit);
        assert_eq!(rev.max_timeout_ms, 600_000);

        use PayloadKind::*;
        let check = |kind: PayloadKind, v: Value, ok: bool| {
            assert_eq!(
                validate_payload("camera.capture", 1, kind, &v).is_ok(),
                ok,
                "{kind:?} {v}"
            )
        };
        check(Params, json!({"mode":"photo"}), true);
        check(Params, json!({"mode":"photo","facing":"front"}), true);
        check(Params, json!({"mode":"video","facing":"back"}), true);
        check(Params, json!({"mode":"video","maxDurationMs":1}), true);
        check(Params, json!({"mode":"video","maxDurationMs":600000}), true);
        check(Params, json!({"mode":"video","maxDurationMs":0}), false);
        check(
            Params,
            json!({"mode":"video","maxDurationMs":600001}),
            false,
        );
        check(Params, json!({"mode":"video","maxDurationMs":null}), false);
        check(Params, json!({"mode":"photo","maxDurationMs":1000}), false);
        check(Params, json!({"mode":"photo","facing":null}), false);
        check(Params, json!({"mode":"photo","facing":"side"}), false);
        check(Params, json!({"mode":"audio"}), false);
        check(Params, json!({"facing":"front"}), false);
        check(Params, json!({"mode":"photo","x":1}), false);

        let sha = "5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347";
        let item =
            |ch: u16, ct: &str| json!({"channel":ch,"contentType":ct,"bytes":17,"sha256":sha});
        for ct in [
            "image/jpeg",
            "image/heic",
            "video/mp4",
            "video/quicktime",
            "video/webm",
        ] {
            check(Result, json!({ "items": [item(0, ct)] }), true);
            check(
                Event,
                json!({"kind":"blobStart","channel":0,"contentType":ct}),
                true,
            );
        }
        check(Result, json!({"items": []}), false);
        check(
            Result,
            json!({"items": [item(0, "image/jpeg"), item(1, "image/jpeg")]}),
            false,
        );
        check(
            Result,
            json!({"items": [item(0, "image/jpeg"), item(0, "image/jpeg")]}),
            false,
        );
        check(Result, json!({"items": [item(1, "image/jpeg")]}), false);
        check(Result, json!({"items": [item(0, "image/png")]}), false);
        check(
            Result,
            json!({"items": [item(0, "video/webm;codecs=vp8")]}),
            false,
        );
        check(Result, json!({"items": [item(0, "IMAGE/JPEG")]}), false);
        check(
            Event,
            json!({"kind":"blobStart","channel":0,"contentType":"image/png"}),
            false,
        );
        check(
            Event,
            json!({"kind":"blobStart","channel":1,"contentType":"image/jpeg"}),
            false,
        );

        let photo = CameraCaptureParams {
            mode: CaptureMode::Photo,
            facing: None,
            max_duration_ms: None,
        };
        assert!(photo.accepts_content_type("image/heic"));
        assert!(!photo.accepts_content_type("video/mp4"));
        let video = CameraCaptureParams {
            mode: CaptureMode::Video,
            ..photo
        };
        assert!(video.accepts_content_type("video/webm"));
        assert!(!video.accepts_content_type("image/jpeg"));
    }

    /// C3: `mic.record@1` optional `channels` is 1 or 2 (absent = 1).
    #[test]
    fn mic_record_channels_is_optional_one_or_two() {
        use PayloadKind::Params;
        let check = |v: Value, ok: bool| {
            assert_eq!(
                validate_payload("mic.record", 1, Params, &v).is_ok(),
                ok,
                "{v}"
            )
        };
        check(
            json!({"sampleRate":48000,"format":"pcm16","channels":1}),
            true,
        );
        check(
            json!({"sampleRate":48000,"format":"pcm16","channels":2}),
            true,
        );
        check(
            json!({"sampleRate":48000,"format":"pcm16","channels":2,"maxDurationMs":500}),
            true,
        );
        for bad in [
            json!(0),
            json!(3),
            json!(256),
            json!(-1),
            json!(null),
            json!("2"),
        ] {
            check(
                json!({"sampleRate":48000,"format":"pcm16","channels":bad}),
                false,
            );
        }
        let p: MicRecordParams =
            serde_json::from_value(json!({"sampleRate":8000,"format":"pcm16"})).unwrap();
        assert_eq!(p.channel_count(), 1);
    }

    /// C4: `bluetooth.select@1` registry entry, filters and identity result.
    #[test]
    fn bluetooth_select_revision_and_payloads() {
        let rev = find_revision("bluetooth.select", 1).expect("bluetooth.select@1");
        assert_eq!(rev.mode, Mode::Unary);
        assert_eq!(rev.data, DataPlane::None);
        assert_eq!(rev.consent, Consent::PerUse);
        assert_eq!(rev.lifetimes, ACTIVATION_ONLY);
        assert_eq!(rev.max_timeout_ms, 300_000);
        assert_eq!(
            (
                rev.max_items,
                rev.max_item_bytes,
                rev.max_initial_credit,
                rev.max_outstanding_credit
            ),
            (0, 0, 0, 0)
        );

        use PayloadKind::*;
        let check = |kind: PayloadKind, v: Value, ok: bool| {
            assert_eq!(
                validate_payload("bluetooth.select", 1, kind, &v).is_ok(),
                ok,
                "{kind:?} {v}"
            )
        };
        let hr = "0000180d-0000-1000-8000-00805f9b34fb";
        let uuid = |i: usize| format!("{i:08x}-0000-1000-8000-00805f9b34fb");
        check(Params, json!({}), true);
        check(Params, json!({"services":[hr]}), true);
        check(Params, json!({"namePrefix":"Polar"}), true);
        check(
            Params,
            json!({"services":[hr],"namePrefix":"\u{1F600}".repeat(64)}),
            true,
        );
        check(
            Params,
            json!({"services":(0..16).map(uuid).collect::<Vec<_>>()}),
            true,
        );
        check(
            Params,
            json!({"services":(0..17).map(uuid).collect::<Vec<_>>()}),
            false,
        );
        check(Params, json!({"services":[]}), false);
        check(Params, json!({"services":[hr, hr]}), false);
        check(Params, json!({"services":null}), false);
        check(Params, json!({"namePrefix":""}), false);
        check(Params, json!({"namePrefix":"x".repeat(65)}), false);
        check(Params, json!({"namePrefix":null}), false);
        check(Params, json!({"acceptAllDevices":true}), false);
        for bad in [
            "0x180d",
            "180d",
            "0000180D-0000-1000-8000-00805F9B34FB",
            "0000180d00001000800000805f9b34fb",
            "{0000180d-0000-1000-8000-00805f9b34fb}",
            "0000180d-0000-1000-8000-00805f9b34f",
            "0000180d-0000-1000-8000-00805f9b34fbb",
            "0000180g-0000-1000-8000-00805f9b34fb",
            "0000180d_0000-1000-8000-00805f9b34fb",
            "heart_rate",
        ] {
            assert!(!is_bluetooth_uuid(bad), "{bad}");
            check(Params, json!({ "services": [bad] }), false);
        }
        assert!(is_bluetooth_uuid(hr));

        check(Result, json!({"device":{"id":"dev-1"}}), true);
        check(Result, json!({"device":{"id":"dev-1","name":""}}), true);
        check(
            Result,
            json!({"device":{"id":"x".repeat(128),"name":"n".repeat(256)}}),
            true,
        );
        check(Result, json!({"device":{"id":""}}), false);
        check(Result, json!({"device":{"id":"x".repeat(129)}}), false);
        check(
            Result,
            json!({"device":{"id":"a","name":"n".repeat(257)}}),
            false,
        );
        check(Result, json!({"device":{"id":"a","name":null}}), false);
        check(Result, json!({"device":{"id":"a","rssi":-40}}), false);
        check(Result, json!({"device":null}), false);
        check(Result, json!({}), false);
        check(
            Event,
            json!({"kind":"progress","state":"pendingConsent"}),
            true,
        );
        check(Event, json!({"device":{"id":"a","rssi":-40}}), false);
        check(
            Event,
            json!({"kind":"blobStart","channel":0,"contentType":"a"}),
            false,
        );
    }

    #[test]
    fn camera_blob_start_must_fit_the_requested_mode() {
        let bs = |ct: &str| BlobStart {
            kind: BlobStartKind::BlobStart,
            channel: 0,
            content_type: ct.into(),
            bytes: None,
        };
        let photo = json!({"mode":"photo"});
        let video = json!({"mode":"video","maxDurationMs":1000});
        let fits = |p: &Value, ct: &str| {
            validate_blob_start_for_request("camera.capture", 1, p, &bs(ct)).is_ok()
        };
        assert!(fits(&photo, "image/jpeg") && fits(&photo, "image/heic"));
        assert!(!fits(&photo, "video/mp4") && !fits(&photo, "video/webm"));
        assert!(fits(&video, "video/mp4") && fits(&video, "video/quicktime"));
        assert!(fits(&video, "video/webm") && !fits(&video, "image/jpeg"));
        // Other revisions carry no request-dependent blob rule.
        let gp = json!({"mediaTypes":["photo"],"maxCount":1});
        assert!(validate_blob_start_for_request("gallery.pick", 1, &gp, &bs("video/mp4")).is_ok());
    }

    /// Admission of the round-3 revisions: deadlines and data-plane credit
    /// come from each revision's registry entry.
    #[test]
    fn round3_request_admission() {
        let req = |cap: &str, timeout: u64, credit: u64, params: Value| DeviceRequest {
            id: 1,
            capability: cap.into(),
            version: 1,
            owner: Owner::Activation {
                module_instance_id: "m".into(),
                activation_id: 1,
            },
            lifetime: Lifetime::Activation,
            timeout_ms: timeout,
            initial_credit: credit,
            params,
        };
        let code = |r: DeviceRequest| validate_request(&r).err().map(|e| e.code);
        let photo = json!({"mode":"photo"});
        assert_eq!(
            code(req("camera.capture", 600_000, 4 * MIB, photo.clone())),
            None
        );
        assert_eq!(
            code(req("camera.capture", 600_001, 0, photo.clone())),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(
            code(req("camera.capture", 1000, 4 * MIB + 1, photo)),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(
            code(req(
                "camera.capture",
                1000,
                0,
                json!({"mode":"photo","maxDurationMs":5})
            )),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(code(req("bluetooth.select", 300_000, 0, json!({}))), None);
        assert_eq!(
            code(req("bluetooth.select", 300_001, 0, json!({}))),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(
            code(req("bluetooth.select", 1000, 1, json!({}))),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(
            code(req(
                "permission.query",
                1000,
                0,
                json!({"permission":"camra"})
            )),
            Some(DeviceErrorCode::InvalidParams)
        );
        assert_eq!(
            code(req(
                "permission.request",
                1000,
                0,
                json!({"permission":"contacts"})
            )),
            None
        );
    }
}
