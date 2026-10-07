//! The server-side device broker (RFC 001 §2.1–§2.7), sans-IO.
//!
//! One [`DeviceBroker`] is bound to exactly one device-enabled connection and
//! is discarded with it (loss of broker state == connection reset, §2.5).
//! It never touches a socket, a thread, a clock or an RNG: the host feeds it
//! device text and binary frames with the current monotonic time, drives
//! [`DeviceBroker::tick`] at the deadline it reports, reports the transport's
//! buffered bytes, and drains [`DeviceBroker::poll`] into the socket and the
//! handler API. Identical inputs give identical outputs.
//!
//! What it owns (the behaviour every server SDK shares):
//!
//! - request ids (u32, monotone from 1, never reused, the connection resets
//!   before the id space is exhausted) and the live/retired distinction;
//! - owners and lifetimes: activation authority (a request is admitted only
//!   for the module instance's current activation), sweeps on deactivation
//!   and destruction, background owners within a pin cap;
//! - admission of new requests against the live selection and the selected
//!   revision (lifetime, deadline clamp, credit defaults and clamps, params
//!   validation, download announcements);
//! - leases: `renewLease` 1 immediately after the request, then on a fixed
//!   5 s cadence, a bounded unacknowledged window, 15 s expiry, u32
//!   sequences, fabricated/future acknowledgements are violations;
//! - overall deadlines;
//! - credit: batched upload grants with a minimum per-frame budget charge,
//!   JSON event credit replenished as the host consumes events, event token
//!   buckets per request and per connection;
//! - uploads: `blobStart` (declared or undeclared sizes), frames (sequence,
//!   64 KiB, no empty frames, no data while paused, per-item cap and
//!   retained-bytes budgets enforced as bytes arrive), one buffer per
//!   channel, SHA-256 over the received bytes, terminal verification;
//!   binary-upload *streams* hand their bytes to the host in order instead
//!   of buffering them;
//! - downloads (`file.save`): the announcement, frames only within credit
//!   the client grants, the write receipt judged against bytes that really
//!   left through [`DeviceBroker::poll`];
//! - the connection-owned `core.capabilities` stream: opened by
//!   [`DeviceBroker::start`], snapshots replace the live selection, a planned
//!   reopen before its deadline, and any unexpected end closes the device
//!   plane;
//! - strict decoding of every incoming message and the decision-D8 violation
//!   reactions (connection-level vs known-id, liveness before direction);
//! - bulk transport scheduling (64 KiB turns, 256 KiB transport limit,
//!   8 MiB queue bound).
//!
//! What stays native per SDK: admission (Origin / authenticator), the
//! handshake (`hello.device` → [`negotiate`] / `select_device_ack`, resume
//! tokens), the socket pump, timers, the replay firewall and the
//! language-idiomatic handler API.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::scheduler::{BulkScheduler, SchedulerConfig};
use crate::serialize::device::{
    attribute_invalid, decode_event, find_revision, parse_strict_json, registry, select_device_ack,
    validate_blob_start_for_request, validate_payload, BlobStart, CapabilitiesEvent,
    CapabilityOffer, CapabilityRevision, ChannelSeq, Control, DataPlane, DeviceAck, DeviceError,
    DeviceErrorCode, DeviceEvent, DeviceHello, DeviceMessage, DeviceRequest, DeviceResponse,
    FrameError, FrameHeader, Lifetime, MessageKind, Mode, Overflow, Owner, PayloadKind,
    ProgressState, TypedEvent, CORE_CAPABILITIES, DEVICE_PROTOCOL_VERSION, FRAME_HEADER_LEN,
    FRAME_VERSION, LEASE_EXPIRY_MS, LEASE_RENEW_INTERVAL_MS, MAX_BULK_CHUNK_BYTES,
};

// ---------------------------------------------------------------------------
// Constants (RFC 001 §2.3/§2.4/§2.7/§5)
// ---------------------------------------------------------------------------

const KIB: u64 = 1024;
const MIB: u64 = 1024 * 1024;

/// Unacknowledged renewals a request may have outstanding; beyond it the
/// broker stops renewing and the 15 s no-progress rule decides liveness.
pub const LEASE_MAX_UNACKED_RENEWALS: u32 = 3;
/// Hard cap on module instances pinned by live `background` work, per
/// connection (§2.7).
pub const MAX_BACKGROUND_PINNED_MODULES: usize = 2;
/// Per-connection retained upload bytes on a Node/Bun-class host.
pub const DEFAULT_MAX_RETAINED_BYTES: u64 = 128 * MIB;
/// Per-connection retained upload bytes on a Cloudflare Durable Object.
pub const DO_MAX_RETAINED_BYTES: u64 = 16 * MIB;
/// Default aggregate retained bytes across one process's connections.
pub const DEFAULT_PROCESS_RETAINED_BYTES: u64 = 1024 * MIB;
/// Aggregate retained bytes across one Durable Object's connections.
pub const DO_AGGREGATE_RETAINED_BYTES: u64 = 48 * MIB;
/// Default `initialCredit` for binary uploads (clamped to the revision).
pub const DEFAULT_UPLOAD_INITIAL_CREDIT: u64 = 256 * KIB;
/// Default event credit for a JSON stream (clamped to the revision).
pub const DEFAULT_STREAM_INITIAL_CREDIT: u64 = 64;
/// Default overall deadline when the caller names none (clamped).
pub const DEFAULT_TIMEOUT_MS: u64 = 300_000;
/// Server-side JSON-event token buckets (§2.3): burst and refill per second.
pub const STREAM_EVENTS_PER_REQUEST_BURST: f64 = 256.0;
pub const STREAM_EVENTS_PER_REQUEST_PER_SEC: f64 = 128.0;
pub const STREAM_EVENTS_PER_CONNECTION_BURST: f64 = 1024.0;
pub const STREAM_EVENTS_PER_CONNECTION_PER_SEC: f64 = 512.0;
/// Overall deadline of the `core.capabilities` stream (its `max_timeout_ms`);
/// the broker reopens it this long before the deadline (at most a tenth of it).
pub const CONTROL_STREAM_TIMEOUT_MS: u64 = 86_400_000;
pub const CONTROL_STREAM_REOPEN_LEAD_MS: u64 = 60_000;
/// Event credit the broker grants the `core.capabilities` stream.
pub const CONTROL_STREAM_INITIAL_CREDIT: u64 = 8;
/// Minimum budget charge per accepted upload frame (§2.3/§5).
pub const MIN_FRAME_CHARGE_BYTES: u64 = 1024;
/// Streamed uploads: how long the host may go without consuming a chunk
/// after the success terminal before the drain is abandoned (`timeout`).
pub const STREAM_DRAIN_TIMEOUT_MS: u64 = 30_000;
/// Connection-level violations tolerated (burst, refill per second) before
/// the broker closes the device plane ("repeated protocol abuse", §2.1).
pub const CONNECTION_VIOLATION_BURST: f64 = 32.0;
pub const CONNECTION_VIOLATIONS_PER_SEC: f64 = 1.0;
/// WebSocket close code the host uses when the broker closes the device plane.
pub const DEVICE_PLANE_CLOSE_CODE: u16 = 1012;

const PLATFORM_DETAIL_MAX: usize = 512;
const VIOLATION_REASON_MAX: usize = 256;
const CLOSE_REASON_MAX: usize = 120;

// ---------------------------------------------------------------------------
// Handshake helpers shared by every server SDK
// ---------------------------------------------------------------------------

/// Whether a server SDK has an API that consumes this revision (RFC 001 §2.2
/// "advertise only implementable capability names"): unary requests
/// (uploads, downloads, JSON results), JSON event streams and binary-upload
/// streams. A stream without a data plane or a server → client byte stream
/// has no consumer.
pub fn server_consumes(rev: &CapabilityRevision) -> bool {
    rev.mode == Mode::Unary || matches!(rev.data, DataPlane::JsonEvents | DataPlane::BinaryUpload)
}

/// The capabilities a broker-backed server advertises: every registry
/// revision it has a consuming API for, in registry order.
pub fn server_advertisement() -> Vec<CapabilityOffer> {
    registry()
        .iter()
        .filter_map(|decl| {
            let versions: Vec<u32> = decl
                .revisions
                .iter()
                .filter(|r| server_consumes(r))
                .map(|r| r.version)
                .collect();
            (!versions.is_empty()).then(|| CapabilityOffer {
                name: decl.name.to_string(),
                versions,
            })
        })
        .collect()
}

/// Handshake selection for a broker-backed server: `select_device_ack`
/// against [`server_advertisement`] and protocol v1. `binary_route` is
/// whether the transport carries binary frames. `None` disables the device
/// plane (UI-only operation continues).
pub fn negotiate(hello: &DeviceHello, binary_route: bool) -> Option<DeviceAck> {
    select_device_ack(
        hello,
        &[DEVICE_PROTOCOL_VERSION],
        &server_advertisement(),
        binary_route,
    )
}

/// The complete server-side handshake from the raw `hello.device` JSON text
/// (RFC 001 §2.2, decision D7), with a diagnostic when the device plane is
/// disabled — what every server SDK needs instead of its own selection code:
///
/// 1. strict decode + validation of the hello (JSON limits, handshake-v1
///    schema, reserved 0, duplicate names/versions); a failure disables the
///    plane with the decoder's reason — the hello is never repaired;
/// 2. [`select_device_ack`] against `server_capabilities` (default:
///    [`server_advertisement`]) and protocol v1, `binary_route` being whether
///    the transport carries binary frames.
///
/// `Ok(ack)` is the `sessionAck.device` to send; `Err(reason)` means "ack
/// without `device`" and says why (log it; never send it to the client).
pub fn negotiate_explained(
    hello_text: &str,
    binary_route: bool,
    server_capabilities: Option<&[CapabilityOffer]>,
) -> Result<DeviceAck, String> {
    let hello =
        DeviceHello::decode(hello_text).map_err(|e| format!("invalid hello.device: {e}"))?;
    let advertised;
    let server = match server_capabilities {
        Some(list) => list,
        None => {
            advertised = server_advertisement();
            &advertised
        }
    };
    if let Some(ack) = select_device_ack(&hello, &[DEVICE_PROTOCOL_VERSION], server, binary_route) {
        return Ok(ack);
    }
    if !hello.protocol_versions.contains(&DEVICE_PROTOCOL_VERSION) {
        return Err(format!(
            "no mutually supported device protocol version (client {:?}, server [{}])",
            hello.protocol_versions, DEVICE_PROTOCOL_VERSION
        ));
    }
    Err(format!(
        "{CORE_CAPABILITIES}@1 is not mutually supported (it is mandatory)"
    ))
}

const DEVICE_TYPES: [&str; 3] = ["deviceRequest", "deviceResponse", "deviceEvent"];
/// Longest raw spelling of a device `type` value (fully `\uXXXX`-escaped).
const MAX_DEVICE_TYPE_RAW: usize = "deviceResponse".len() * 6 + 2;

/// Whether `text` is a device message over the RFC 001 §2.1 size limit,
/// decided WITHOUT parsing it (the limit is checked before parsing). Only
/// text above the limit is inspected, with one linear scan of its top-level
/// members for `type` (escaped spellings included). Over-limit text that
/// cannot be scanned (malformed, or with a duplicated `type`) counts as
/// device text: it is hostile, and parsing it is exactly the cost the limit
/// exists to avoid. Hosts call this before parsing an incoming text message;
/// `true` means "feed it to [`DeviceBroker::on_text`]" (which counts it as a
/// connection-level violation) and never parse it.
pub fn is_oversize_device_text(text: &str) -> bool {
    if text.len() <= crate::serialize::device::limits::MESSAGE_MAX_BYTES {
        return false;
    }
    match top_level_member(text.as_bytes(), "type") {
        Err(()) => true,
        Ok(None) => false,
        Ok(Some(raw)) => {
            if raw.len() > MAX_DEVICE_TYPE_RAW || raw.first() != Some(&b'"') {
                return false;
            }
            match std::str::from_utf8(raw)
                .ok()
                .and_then(|s| serde_json::from_str::<String>(s).ok())
            {
                Some(t) => DEVICE_TYPES.contains(&t.as_str()),
                None => true,
            }
        }
    }
}

/// The raw JSON text of `member` in the top-level object `text`, found by one
/// linear scan without parsing the rest (RFC 001 §2.1/§2.2): `Ok(None)` when
/// absent, `Err(())` when `text` is not a scannable object or repeats the
/// member (an ambiguous value — a duplicated `hello.device` disables the
/// device plane, decision D4). The returned slice is untrusted and still has
/// to go through the strict decoders ([`DeviceHello::decode`] for
/// `hello.device`, [`DeviceAck::decode`] for `sessionAck.device`).
///
/// Server SDKs use it to hand the exact `hello.device` text to
/// [`negotiate_explained`]; clients use it to route a text message by its
/// `type` before the strict device decoders see it.
// `()`: the only failure is "not a scannable object / repeated member",
// which callers treat as "ambiguous" without distinguishing further.
#[allow(clippy::result_unit_err)]
pub fn top_level_member_text<'a>(text: &'a str, member: &str) -> Result<Option<&'a str>, ()> {
    match top_level_member(text.as_bytes(), member)? {
        None => Ok(None),
        // The scanner only splits at ASCII delimiters, so the slice is
        // valid UTF-8 whenever `text` is.
        Some(raw) => std::str::from_utf8(raw).map(Some).map_err(|_| ()),
    }
}

/// The device message `type` of `text` (`deviceRequest`, `deviceResponse`,
/// `deviceEvent`), decided by a top-level scan without parsing the message;
/// `None` for every other (or unscannable) text. Routing only: the message
/// itself is untrusted until [`DeviceMessage::decode`] accepts it.
pub fn device_message_type(text: &str) -> Option<&'static str> {
    let raw = top_level_member(text.as_bytes(), "type").ok()??;
    if raw.len() > MAX_DEVICE_TYPE_RAW || raw.first() != Some(&b'"') {
        return None;
    }
    let t: String = serde_json::from_str(std::str::from_utf8(raw).ok()?).ok()?;
    DEVICE_TYPES.iter().copied().find(|d| *d == t)
}

/// Linear scan of a JSON object's top-level members: the raw value of
/// `member`, `Ok(None)` when absent, `Err(())` when the text is not a
/// scannable object or repeats the member.
fn top_level_member<'a>(b: &'a [u8], member: &str) -> Result<Option<&'a [u8]>, ()> {
    let mut i = 0usize;
    let ws = |i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    };
    // Skip one JSON string starting at `*i` (which must be a quote).
    fn skip_string(b: &[u8], i: &mut usize) -> Result<(), ()> {
        if b.get(*i) != Some(&b'"') {
            return Err(());
        }
        *i += 1;
        while *i < b.len() {
            match b[*i] {
                b'\\' => *i += 2,
                b'"' => {
                    *i += 1;
                    return Ok(());
                }
                _ => *i += 1,
            }
        }
        Err(())
    }
    // Skip one JSON value (containers by bracket depth, strings exactly).
    fn skip_value(b: &[u8], i: &mut usize) -> Result<(), ()> {
        let mut depth = 0usize;
        loop {
            let c = *b.get(*i).ok_or(())?;
            match c {
                b'"' => skip_string(b, i)?,
                b'{' | b'[' => {
                    depth += 1;
                    *i += 1;
                }
                b'}' | b']' => {
                    if depth == 0 {
                        return Ok(());
                    }
                    depth -= 1;
                    *i += 1;
                }
                b',' if depth == 0 => return Ok(()),
                _ => *i += 1,
            }
            if depth == 0 && matches!(c, b'"' | b'}' | b']') {
                return Ok(());
            }
        }
    }
    ws(&mut i);
    if b.get(i) != Some(&b'{') {
        return Err(());
    }
    i += 1;
    let min_key = member.len() + 2;
    let max_key = member.len() * 6 + 2;
    let mut found: Option<&[u8]> = None;
    loop {
        ws(&mut i);
        match b.get(i) {
            Some(b'}') => return Ok(found),
            Some(b'"') => {}
            _ => return Err(()),
        }
        let key_start = i;
        skip_string(b, &mut i)?;
        let raw_key = &b[key_start..i];
        let key = if raw_key.len() >= min_key && raw_key.len() <= max_key {
            let s = std::str::from_utf8(raw_key).map_err(|_| ())?;
            Some(serde_json::from_str::<String>(s).map_err(|_| ())?)
        } else {
            None
        };
        ws(&mut i);
        if b.get(i) != Some(&b':') {
            return Err(());
        }
        i += 1;
        ws(&mut i);
        let value_start = i;
        skip_value(b, &mut i)?;
        let raw_value = trim_ws(&b[value_start..i]);
        if raw_value.is_empty() {
            return Err(()); // a member without a value
        }
        if key.as_deref() == Some(member) {
            if found.is_some() {
                return Err(());
            }
            found = Some(raw_value);
        }
        ws(&mut i);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => return Ok(found),
            _ => return Err(()),
        }
    }
}

fn trim_ws(mut s: &[u8]) -> &[u8] {
    while let Some((last, rest)) = s.split_last() {
        if matches!(last, b' ' | b'\t' | b'\n' | b'\r') {
            s = rest;
        } else {
            break;
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// An aggregate retained-bytes budget shared by several brokers (every
/// connection of one process, or of one Durable Object), next to each
/// connection's own budget (§2.4/§5). Cloning shares the pool.
#[derive(Debug, Clone)]
pub struct RetainedBytesPool {
    inner: Arc<PoolInner>,
}

#[derive(Debug)]
struct PoolInner {
    limit: u64,
    used: AtomicU64,
}

impl RetainedBytesPool {
    pub fn new(limit: u64) -> Self {
        RetainedBytesPool {
            inner: Arc::new(PoolInner {
                limit,
                used: AtomicU64::new(0),
            }),
        }
    }

    pub fn limit(&self) -> u64 {
        self.inner.limit
    }

    /// Bytes currently reserved across every broker using this pool.
    pub fn in_use(&self) -> u64 {
        self.inner.used.load(Ordering::SeqCst)
    }

    /// Reserve `bytes`, or refuse (reserving nothing) past the limit.
    pub fn try_reserve(&self, bytes: u64) -> bool {
        if bytes == 0 {
            return true;
        }
        self.inner
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&n| n <= self.inner.limit)
            })
            .is_ok()
    }

    pub fn release(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let _ = self
            .inner
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            });
    }
}

/// JSON-event token buckets (§2.3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EventRate {
    pub request_burst: f64,
    pub request_per_second: f64,
    pub connection_burst: f64,
    pub connection_per_second: f64,
}

impl Default for EventRate {
    fn default() -> Self {
        EventRate {
            request_burst: STREAM_EVENTS_PER_REQUEST_BURST,
            request_per_second: STREAM_EVENTS_PER_REQUEST_PER_SEC,
            connection_burst: STREAM_EVENTS_PER_CONNECTION_BURST,
            connection_per_second: STREAM_EVENTS_PER_CONNECTION_PER_SEC,
        }
    }
}

/// Connection-level violation tolerance before the device plane closes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViolationRate {
    pub burst: f64,
    pub per_second: f64,
}

impl Default for ViolationRate {
    fn default() -> Self {
        ViolationRate {
            burst: CONNECTION_VIOLATION_BURST,
            per_second: CONNECTION_VIOLATIONS_PER_SEC,
        }
    }
}

/// A host- or test-supplied replacement for one registry revision (e.g. a
/// revision that allows `background`). The payload schemas stay those of
/// the shipped revision with the same name and version.
#[derive(Debug, Clone, PartialEq)]
pub struct RevisionOverride {
    pub capability: String,
    pub revision: CapabilityRevision,
}

/// Everything a broker is configured with at construction.
#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// The negotiated `sessionAck.device` (initial live selection, binary).
    /// It is the ceiling for the whole connection: `core.capabilities`
    /// snapshots narrow or restore the live selection within it, never
    /// widen it (§2.2).
    pub ack: DeviceAck,
    /// What this server advertised: the input the ack was negotiated
    /// against (first entry per name wins). The ack is already a subset of
    /// it, so snapshots are intersected with the ack alone.
    pub server_capabilities: Vec<CapabilityOffer>,
    /// Per-connection retained-bytes budget.
    pub max_retained_bytes: u64,
    /// Host cap on a single blob item (RFC 001 §2.4 "advertise only limits
    /// they can honor"); applied to every revision's `max_item_bytes`.
    pub max_item_bytes: Option<u64>,
    /// Aggregate budget shared with other connections.
    pub pool: Option<RetainedBytesPool>,
    /// Hard cap on modules pinned by live background work.
    pub max_background_owners: usize,
    /// Minimum budget charge per accepted upload frame.
    pub min_frame_charge: u64,
    /// Streamed uploads: consumer progress bound after the success terminal.
    pub drain_timeout_ms: u64,
    pub event_rate: EventRate,
    pub violation_rate: ViolationRate,
    /// Overall deadline of the `core.capabilities` stream (clamped to its
    /// revision); the broker reopens it before this expires.
    pub control_stream_timeout_ms: u64,
    /// Event credit of the `core.capabilities` stream (clamped).
    pub control_stream_initial_credit: u64,
    pub scheduler: SchedulerConfig,
    /// Registry revision replacements (injection seam).
    pub revision_overrides: Vec<RevisionOverride>,
    /// Ids are allocated below this bound; reaching it closes the device
    /// plane so the client re-handshakes (§2.1). Default `u32::MAX`.
    pub request_id_limit: u32,
}

impl BrokerConfig {
    /// Defaults for a connection that negotiated `ack`, advertising
    /// [`server_advertisement`].
    pub fn new(ack: DeviceAck) -> Self {
        BrokerConfig {
            ack,
            server_capabilities: server_advertisement(),
            max_retained_bytes: DEFAULT_MAX_RETAINED_BYTES,
            max_item_bytes: None,
            pool: None,
            max_background_owners: MAX_BACKGROUND_PINNED_MODULES,
            min_frame_charge: MIN_FRAME_CHARGE_BYTES,
            drain_timeout_ms: STREAM_DRAIN_TIMEOUT_MS,
            event_rate: EventRate::default(),
            violation_rate: ViolationRate::default(),
            control_stream_timeout_ms: CONTROL_STREAM_TIMEOUT_MS,
            control_stream_initial_credit: CONTROL_STREAM_INITIAL_CREDIT,
            scheduler: SchedulerConfig::default(),
            revision_overrides: Vec::new(),
            request_id_limit: u32::MAX,
        }
    }
}

/// Why the broker refused to open a request locally (nothing was sent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRefusal {
    pub code: DeviceErrorCode,
    pub detail: Option<String>,
}

impl LocalRefusal {
    fn new(code: DeviceErrorCode, detail: impl Into<String>) -> Self {
        LocalRefusal {
            code,
            detail: Some(detail.into()),
        }
    }
    fn bare(code: DeviceErrorCode) -> Self {
        LocalRefusal { code, detail: None }
    }
}

impl fmt::Display for LocalRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "{:?}: {d}", self.code),
            None => write!(f, "{:?}", self.code),
        }
    }
}

impl std::error::Error for LocalRefusal {}

/// What a handler asks for. The owner is always the invoking module
/// instance's current activation; `lifetime: Background` moves ownership to
/// the module instance (within the pin cap).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenSpec {
    pub capability: String,
    /// Exact revision; `None` = the live selection's revision.
    pub version: Option<u32>,
    pub params: Value,
    pub module_instance_id: String,
    pub activation_id: u32,
    /// `None` = the revision's first (default) lifetime.
    pub lifetime: Option<Lifetime>,
    /// `None` = [`DEFAULT_TIMEOUT_MS`]; always clamped to the revision.
    pub timeout_ms: Option<u64>,
    /// `None` = the data plane's default; clamped to the revision. An
    /// explicit 0 on a client → server data plane is refused unless
    /// `allow_zero_credit` is set.
    pub initial_credit: Option<u64>,
    /// Accept an explicit `initial_credit: Some(0)` on a client → server
    /// data plane: protocol-legal (the sender reports `paused` and the
    /// broker widens the window), but a handler API refuses it by default
    /// because nothing flows until the client pauses.
    pub allow_zero_credit: bool,
    /// The operation shape the caller's API expects (`request` = unary,
    /// `stream` = stream); `None` accepts either.
    pub mode: Option<Mode>,
    /// Server → client download bytes (`file.save`): the params must
    /// announce exactly these bytes (see [`file_save_params`]).
    pub download: Option<Vec<u8>>,
    /// Keep a successful result's retained-bytes charge until
    /// [`DeviceBroker::release_result`] (completed-but-unconsumed results
    /// count toward the connection quota, §2.4).
    pub hold_result: bool,
    /// The replay firewall (RFC 001 §1.7): the handler runs for a replayed
    /// (`syncActions`) or broadcast-derived dispatch. Such a request is
    /// refused `unavailable` before anything else is looked at; the SDK sets
    /// this from the dispatch's provenance, which survives `await`.
    pub replayed: bool,
}

impl OpenSpec {
    /// A spec with defaults for everything but the essentials.
    pub fn new(
        capability: impl Into<String>,
        params: Value,
        module_instance_id: impl Into<String>,
        activation_id: u32,
    ) -> Self {
        OpenSpec {
            capability: capability.into(),
            version: None,
            params,
            module_instance_id: module_instance_id.into(),
            activation_id,
            lifetime: None,
            timeout_ms: None,
            initial_credit: None,
            allow_zero_credit: false,
            mode: None,
            download: None,
            hold_result: false,
            replayed: false,
        }
    }

    /// A `file.save` of `bytes` (params built with [`file_save_params`]).
    pub fn save(
        name: &str,
        content_type: &str,
        bytes: Vec<u8>,
        module_instance_id: impl Into<String>,
        activation_id: u32,
    ) -> Self {
        let mut spec = OpenSpec::new(
            "file.save",
            file_save_params(name, content_type, &bytes),
            module_instance_id,
            activation_id,
        );
        spec.download = Some(bytes);
        spec
    }
}

/// The `file.save@1` announcement for `bytes`: `{channel: 0, name,
/// contentType, bytes, sha256}`.
pub fn file_save_params(name: &str, content_type: &str, bytes: &[u8]) -> Value {
    json!({
        "channel": 0,
        "name": name,
        "contentType": content_type,
        "bytes": bytes.len() as u64,
        "sha256": sha256_hex(bytes),
    })
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(digest: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// One verified upload item of a successful unary result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    pub channel: u16,
    /// The result item's `name`, when the revision carries one (file.pick).
    pub name: Option<String>,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A request's single terminal outcome.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Ok {
        /// The client's result, validated against the selected revision.
        result: Value,
        /// Verified upload items (buffered unary uploads), in result order.
        blobs: Vec<Blob>,
        /// Produced by a fake host (`simulated: true`, RFC 001 §1.11).
        simulated: bool,
        /// The result's retained-bytes charge is held until
        /// [`DeviceBroker::release_result`].
        held: bool,
    },
    Err {
        code: DeviceErrorCode,
        detail: Option<String>,
    },
}

impl Outcome {
    fn err(code: DeviceErrorCode) -> Self {
        Outcome::Err { code, detail: None }
    }
    fn err_detail(code: DeviceErrorCode, detail: impl Into<String>) -> Self {
        Outcome::Err {
            code,
            detail: Some(truncate(&detail.into(), PLATFORM_DETAIL_MAX)),
        }
    }
    pub fn is_ok(&self) -> bool {
        matches!(self, Outcome::Ok { .. })
    }
    /// The error code, when this is an error.
    pub fn code(&self) -> Option<DeviceErrorCode> {
        match self {
            Outcome::Err { code, .. } => Some(*code),
            Outcome::Ok { .. } => None,
        }
    }
}

/// Everything the broker asks the host to do, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// Send this device JSON message on the text channel (server → client:
    /// requests, cancel, renewLease, grant).
    SendText(String),
    /// Send this binary frame (download bytes), already scheduled.
    SendFrame(Vec<u8>),
    /// A validated JSON stream event for request `id`'s consumer. Call
    /// [`DeviceBroker::consumed_events`] once the consumer is done with it.
    Event { id: u32, event: Value },
    /// Upload bytes of a binary-upload stream, in order. Call
    /// [`DeviceBroker::consumed_data`] once the consumer is done with it.
    Data {
        id: u32,
        channel: u16,
        bytes: Vec<u8>,
    },
    /// Request `id` ended (exactly once per opened request).
    Settled { id: u32, outcome: Outcome },
    /// The broker closed the device plane: close the socket with this code
    /// (the client reconnects with a full advertisement).
    CloseConnection { code: u16, reason: String },
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct TokenBucket {
    capacity: f64,
    per_second: f64,
    tokens: f64,
    last: u64,
}

impl TokenBucket {
    fn new(capacity: f64, per_second: f64, now: u64) -> Self {
        TokenBucket {
            capacity,
            per_second,
            tokens: capacity,
            last: now,
        }
    }

    fn take(&mut self, now: u64) -> bool {
        let elapsed = now.saturating_sub(self.last) as f64;
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.per_second / 1000.0).min(self.capacity);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReqOwner {
    Activation { module: String, activation: u32 },
    Background { module: String },
    Connection,
}

impl ReqOwner {
    fn wire(&self) -> Owner {
        match self {
            ReqOwner::Activation { module, activation } => Owner::Activation {
                module_instance_id: module.clone(),
                activation_id: *activation,
            },
            ReqOwner::Background { module } => Owner::Module {
                module_instance_id: module.clone(),
            },
            ReqOwner::Connection => Owner::Connection { connection: true },
        }
    }

    /// Swept by `owner_deactivated(module, Some(a))` / `owner_destroyed`
    /// (`activation == None`).
    fn swept_by(&self, module_id: &str, activation_id: Option<u32>) -> bool {
        match self {
            ReqOwner::Activation { module, activation } => {
                module == module_id && activation_id.is_none_or(|a| a == *activation)
            }
            ReqOwner::Background { module } => activation_id.is_none() && module == module_id,
            ReqOwner::Connection => false,
        }
    }
}

#[derive(Debug)]
struct Channel {
    content_type: String,
    declared: Option<u64>,
    received: u64,
    seq: ChannelSeq,
    /// Buffered channels: the payload (one growable buffer per channel).
    buf: Vec<u8>,
    /// Logical buffer capacity the budget is charged for.
    capacity: u64,
    /// Sum of per-frame charges (`max(len, min_frame_charge)`).
    frame_charge: u64,
    /// Bytes this channel holds against the budgets (buffered channels).
    charged: u64,
    /// SHA-256 of every byte received on the channel.
    hash: Sha256,
}

#[derive(Debug, Clone, Copy)]
struct QueuedChunk {
    len: u64,
    charge: u64,
}

#[derive(Debug)]
struct Download {
    bytes: Vec<u8>,
    /// Bytes already queued as frames.
    offset: usize,
    /// Bytes handed to the transport through `poll`.
    written: usize,
    seq: u64,
    /// Client-granted credit not yet spent.
    credit: u64,
}

#[derive(Debug)]
struct Request {
    id: u32,
    capability: String,
    version: u32,
    owner: ReqOwner,
    rev: CapabilityRevision,
    params: Value,
    /// The connection-owned `core.capabilities` stream (broker-internal:
    /// no `Settled` output; its end closes the plane unless retired).
    core: bool,
    hold_result: bool,
    opened_at: u64,
    timeout_ms: u64,
    next_renew_at: u64,
    lease_seq: u32,
    acked_seq: u32,
    last_progress: u64,
    reserved_bytes: u64,
    event_credit: u64,
    event_grant_batch: u64,
    event_consumed: u64,
    /// Events handed to the host as [`Output::Event`] and not yet reported
    /// by `consumed_events` — the ceiling on what the host may report.
    events_unconsumed: u64,
    event_bucket: TokenBucket,
    max_channels: u64,
    upload_credit: u64,
    upload_consumed: u64,
    upload_grant_batch: u64,
    upload_window: u64,
    channels: BTreeMap<u16, Channel>,
    /// Binary-upload stream: bytes go to the host as `Data` outputs.
    streamed: bool,
    /// `Data` chunks handed out and not yet consumed, in order.
    data_queue: VecDeque<QueuedChunk>,
    /// Draining toward a success (id retired, chunks still unconsumed).
    drain: Option<(Outcome, u64)>,
    download: Option<Download>,
    paused: bool,
    progress: Option<ProgressState>,
    data_seen: bool,
}

/// A request-level termination decided by a handler.
struct Term {
    outcome: Outcome,
    /// Send `cancel` (false when the offending message was the client's own
    /// terminal, which already retired the id on the client).
    notify: bool,
}

impl Term {
    fn violation(detail: impl Into<String>) -> Self {
        Term {
            outcome: Outcome::err_detail(DeviceErrorCode::InvalidParams, detail),
            notify: true,
        }
    }
    fn quiet_violation(detail: impl Into<String>) -> Self {
        Term {
            outcome: Outcome::err_detail(DeviceErrorCode::InvalidParams, detail),
            notify: false,
        }
    }
    fn throttled(detail: impl Into<String>) -> Self {
        Term {
            outcome: Outcome::err_detail(DeviceErrorCode::Throttled, detail),
            notify: true,
        }
    }
    fn code(code: DeviceErrorCode) -> Self {
        Term {
            outcome: Outcome::err(code),
            notify: true,
        }
    }
}

#[derive(Debug, Default, Clone)]
struct ActivationState {
    highest: u32,
    active: Option<u32>,
    destroyed: bool,
}

/// Connection-wide mutable state the per-request handlers need beside the
/// request itself (split from the request maps for the borrow checker).
struct Ctx {
    outputs: VecDeque<Output>,
    reserved: u64,
    max_retained: u64,
    pool: Option<RetainedBytesPool>,
    min_frame_charge: u64,
    connection_events: TokenBucket,
    scheduler: BulkScheduler,
}

impl Ctx {
    fn send(&mut self, msg: DeviceMessage) {
        let text = serde_json::to_string(&msg).expect("device messages serialize");
        self.outputs.push_back(Output::SendText(text));
    }

    fn send_control(&mut self, id: u32, control: Control) {
        self.send(DeviceMessage::DeviceEvent(DeviceEvent {
            id,
            event: None,
            control: Some(control),
        }));
    }

    /// Reserve `bytes` against the connection budget and the shared pool.
    fn reserve(&mut self, req: &mut Request, bytes: u64) -> bool {
        if bytes == 0 {
            return true;
        }
        if self.reserved + bytes > self.max_retained {
            return false;
        }
        if let Some(pool) = &self.pool {
            if !pool.try_reserve(bytes) {
                return false;
            }
        }
        self.reserved += bytes;
        req.reserved_bytes += bytes;
        true
    }

    fn release(&mut self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        self.reserved = self.reserved.saturating_sub(bytes);
        if let Some(pool) = &self.pool {
            pool.release(bytes);
        }
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

/// The server-side device broker for one connection. See the module docs.
pub struct DeviceBroker {
    config: BrokerConfig,
    ctx: Ctx,
    reqs: BTreeMap<u32, Request>,
    /// Streamed uploads whose success terminal arrived while chunks still
    /// await the consumer: retired ids that still hold budget.
    draining: BTreeMap<u32, Request>,
    /// Settled results whose charge is held until `release_result`.
    held: BTreeMap<u32, u64>,
    next_id: u32,
    closed: bool,
    started: bool,
    core_id: Option<u32>,
    core_reopen_at: Option<u64>,
    binary: bool,
    /// The negotiated selection (the ack's pairs this broker can serve):
    /// the ceiling of the live selection for the whole connection (§2.2).
    negotiated: Vec<(String, u32)>,
    /// Live selection: capability name → exact revision, in selection order.
    selection: Vec<(String, u32)>,
    activations: HashMap<String, ActivationState>,
    violation_bucket: TokenBucket,
    connection_violations: u64,
    last_connection_violation: Option<String>,
    transport_buffered: usize,
    now: u64,
}

impl fmt::Debug for DeviceBroker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceBroker")
            .field("live", &self.reqs.keys().collect::<Vec<_>>())
            .field("draining", &self.draining.keys().collect::<Vec<_>>())
            .field("closed", &self.closed)
            .field("core_id", &self.core_id)
            .field("selection", &self.selection)
            .finish()
    }
}

impl DeviceBroker {
    /// A broker for one connection that negotiated `config.ack`. Nothing is
    /// sent until [`Self::start`] opens the `core.capabilities` stream.
    pub fn new(config: BrokerConfig, now_ms: u64) -> Self {
        let ctx = Ctx {
            outputs: VecDeque::new(),
            reserved: 0,
            max_retained: config.max_retained_bytes,
            pool: config.pool.clone(),
            min_frame_charge: config.min_frame_charge.max(1),
            connection_events: TokenBucket::new(
                config.event_rate.connection_burst,
                config.event_rate.connection_per_second,
                now_ms,
            ),
            scheduler: BulkScheduler::new(config.scheduler),
        };
        let violation_bucket = TokenBucket::new(
            config.violation_rate.burst,
            config.violation_rate.per_second,
            now_ms,
        );
        let mut broker = DeviceBroker {
            binary: config.ack.binary,
            config,
            ctx,
            reqs: BTreeMap::new(),
            draining: BTreeMap::new(),
            held: BTreeMap::new(),
            next_id: 1,
            closed: false,
            started: false,
            core_id: None,
            core_reopen_at: None,
            negotiated: Vec::new(),
            selection: Vec::new(),
            activations: HashMap::new(),
            violation_bucket,
            connection_violations: 0,
            last_connection_violation: None,
            transport_buffered: 0,
            now: now_ms,
        };
        // The negotiated selection (the ceiling, and the initial live
        // selection) is the ack's — restricted to revisions
        // this broker declares, without binary planes on a JSON-only
        // connection (defensive: `select_device_ack` never selects either).
        let mut seen = HashSet::new();
        broker.negotiated = broker
            .config
            .ack
            .capabilities
            .iter()
            .filter(|c| seen.insert(c.name.clone()))
            .filter(|c| {
                broker
                    .revision(&c.name, c.version)
                    .is_some_and(|r| broker.binary || !r.data.is_binary())
            })
            .map(|c| (c.name.clone(), c.version))
            .collect();
        broker.selection = broker.negotiated.clone();
        broker
    }

    // ---- queries ---------------------------------------------------------

    pub fn config(&self) -> &BrokerConfig {
        &self.config
    }

    /// Live requests, the internal `core.capabilities` stream included.
    pub fn live_count(&self) -> usize {
        self.reqs.len()
    }

    /// Streamed uploads retired on success but not yet fully consumed.
    pub fn draining_count(&self) -> usize {
        self.draining.len()
    }

    pub fn is_live(&self, id: u32) -> bool {
        self.reqs.contains_key(&id)
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn is_started(&self) -> bool {
        self.started
    }

    /// Whether the connection negotiated the binary frame profile.
    pub fn is_binary(&self) -> bool {
        self.binary
    }

    /// The live `core.capabilities` stream's id.
    pub fn core_stream_id(&self) -> Option<u32> {
        self.core_id
    }

    /// Upload bytes charged against the connection budget.
    pub fn retained_bytes(&self) -> u64 {
        self.ctx.reserved
    }

    pub fn max_retained_bytes(&self) -> u64 {
        self.ctx.max_retained
    }

    /// Connection-level violations counted so far.
    pub fn connection_violations(&self) -> u64 {
        self.connection_violations
    }

    /// The most recent connection-level violation (bounded diagnostics).
    pub fn last_connection_violation(&self) -> Option<&str> {
        self.last_connection_violation.as_deref()
    }

    /// Outstanding client → server upload credit of a live request.
    pub fn outstanding_credit(&self, id: u32) -> Option<u64> {
        self.reqs.get(&id).map(|r| r.upload_credit)
    }

    /// Outstanding JSON event credit of a live stream.
    pub fn outstanding_event_credit(&self, id: u32) -> Option<u64> {
        self.reqs.get(&id).map(|r| r.event_credit)
    }

    /// Bulk bytes queued for the transport.
    pub fn queued_bulk_bytes(&self) -> usize {
        self.ctx.scheduler.queued_bytes()
    }

    /// Scheduling turns that handed out frames (diagnostics/tests).
    pub fn bulk_turns(&self) -> u64 {
        self.ctx.scheduler.turns()
    }

    /// Negotiated live support for `capability` (not a permission grant).
    pub fn supports(&self, capability: &str) -> bool {
        !self.closed && self.selection.iter().any(|(n, _)| n == capability)
    }

    /// The live selection's revision of `capability`.
    pub fn selected_version(&self, capability: &str) -> Option<u32> {
        self.selection
            .iter()
            .find(|(n, _)| n == capability)
            .map(|(_, v)| *v)
    }

    /// The live selection, `(name, version)` in selection order.
    pub fn selection(&self) -> &[(String, u32)] {
        &self.selection
    }

    /// This broker's view of a revision: registry, overrides, item cap.
    pub fn revision(&self, capability: &str, version: u32) -> Option<CapabilityRevision> {
        let mut rev = self
            .config
            .revision_overrides
            .iter()
            .find(|o| o.capability == capability && o.revision.version == version)
            .map(|o| o.revision)
            .or_else(|| find_revision(capability, version).copied())?;
        if let Some(cap) = self.config.max_item_bytes {
            if rev.max_item_bytes > cap {
                rev.max_item_bytes = cap;
            }
        }
        Some(rev)
    }

    /// Whether `module_instance_id` owns live background work.
    pub fn has_background_work(&self, module_instance_id: &str) -> bool {
        self.reqs.values().any(
            |r| matches!(&r.owner, ReqOwner::Background { module } if module == module_instance_id),
        )
    }

    /// Distinct module instances pinned by live background work.
    pub fn background_owners(&self) -> HashSet<String> {
        self.reqs
            .values()
            .filter_map(|r| match &r.owner {
                ReqOwner::Background { module } => Some(module.clone()),
                _ => None,
            })
            .collect()
    }

    /// Whether a new background request from `module_instance_id` fits the
    /// pin cap: an already-pinned module may add work; a new one only below
    /// the cap.
    pub fn admits_background(&self, module_instance_id: &str) -> bool {
        let owners = self.background_owners();
        owners.contains(module_instance_id) || owners.len() < self.config.max_background_owners
    }

    /// Whether `(module_instance_id, activation_id)` is the module's live
    /// activation (the authority a new activation-owned request needs).
    pub fn owner_is_active(&self, module_instance_id: &str, activation_id: u32) -> bool {
        self.activations
            .get(module_instance_id)
            .is_some_and(|s| !s.destroyed && s.active == Some(activation_id))
    }

    // ---- timers and output -----------------------------------------------

    /// The earliest time [`Self::tick`] must run (absolute monotonic ms), or
    /// `None` when nothing is pending. A value `<=` now means "as soon as
    /// possible" (e.g. bulk frames waiting for their next turn).
    pub fn next_deadline(&self) -> Option<u64> {
        if self.closed {
            return None;
        }
        let mut next: Option<u64> = self.core_reopen_at;
        let mut consider = |t: u64| {
            next = Some(next.map_or(t, |n| n.min(t)));
        };
        for r in self.reqs.values() {
            consider(r.opened_at.saturating_add(r.timeout_ms));
            consider(r.last_progress.saturating_add(LEASE_EXPIRY_MS));
            consider(r.next_renew_at);
        }
        for r in self.draining.values() {
            if let Some((_, progress_at)) = &r.drain {
                consider(
                    progress_at
                        .saturating_add(self.config.drain_timeout_ms.max(1))
                        .min(r.opened_at.saturating_add(r.timeout_ms)),
                );
            }
        }
        if self.ctx.scheduler.has_pending() {
            if self.ctx.scheduler.saturated(self.transport_buffered) {
                consider(
                    self.now
                        .saturating_add(self.ctx.scheduler.config().retry_ms),
                );
            } else {
                consider(self.now);
            }
        }
        next
    }

    /// Run every timer due at `now_ms` (deadlines, lease renewals and
    /// expiry, drain watches, the planned `core.capabilities` reopen) and
    /// return the next deadline.
    pub fn tick(&mut self, now_ms: u64) -> Option<u64> {
        self.advance(now_ms);
        if self.closed {
            return None;
        }
        let now = self.now;
        if self.core_reopen_at.is_some_and(|at| now >= at) {
            self.reopen_core_capabilities(now);
        }
        let ids: Vec<u32> = self.reqs.keys().copied().collect();
        for id in ids {
            if self.closed {
                break;
            }
            let Some(req) = self.reqs.get_mut(&id) else {
                continue;
            };
            // Overall deadline first, then the 15 s no-progress rule — expiry
            // is always evaluated before a renewal goes out (§2.7).
            let term = if now.saturating_sub(req.opened_at) >= req.timeout_ms {
                Some(DeviceErrorCode::Timeout)
            } else if now.saturating_sub(req.last_progress) >= LEASE_EXPIRY_MS {
                Some(DeviceErrorCode::ConnectionLost)
            } else {
                None
            };
            let mut renew = false;
            if term.is_none() && now >= req.next_renew_at {
                // Fixed cadence from the open: missed slots are skipped, one
                // renewal goes out for the current slot — never keyed to the
                // client's ack, whose round trip would stretch the interval.
                // Saturating: host-supplied times may sit near `u64::MAX`.
                let behind = (now - req.next_renew_at) / LEASE_RENEW_INTERVAL_MS + 1;
                req.next_renew_at = req
                    .next_renew_at
                    .saturating_add(behind.saturating_mul(LEASE_RENEW_INTERVAL_MS));
                // Bounded renewal window: too many unacked renewals ⇒ stop
                // renewing; the no-progress rule decides liveness.
                renew = req.lease_seq.saturating_sub(req.acked_seq) <= LEASE_MAX_UNACKED_RENEWALS;
            }
            if let Some(code) = term {
                self.terminate(id, Term::code(code));
            } else if renew {
                self.renew(id);
            }
        }
        let drain_timeout = self.config.drain_timeout_ms.max(1);
        let draining: Vec<u32> = self.draining.keys().copied().collect();
        for id in draining {
            let Some(req) = self.draining.get(&id) else {
                continue;
            };
            let progress_at = req.drain.as_ref().map_or(req.opened_at, |(_, p)| *p);
            if now.saturating_sub(progress_at) >= drain_timeout
                || now.saturating_sub(req.opened_at) >= req.timeout_ms
            {
                self.abort_drain(id, Outcome::err(DeviceErrorCode::Timeout));
            }
        }
        self.next_deadline()
    }

    /// The transport's currently buffered (accepted, unwritten) bytes; bulk
    /// frames are handed out only while this is below the pending limit.
    pub fn set_transport_buffered(&mut self, bytes: usize) {
        self.transport_buffered = bytes;
    }

    /// Drain everything the host must do now: all queued outputs, then at
    /// most one bulk scheduling turn (call again — after sending pending UI
    /// traffic — while [`Self::next_deadline`] reports work due).
    pub fn poll(&mut self) -> Vec<Output> {
        let mut out: Vec<Output> = self.ctx.outputs.drain(..).collect();
        if !self.closed && self.ctx.scheduler.has_pending() {
            for (id, frame) in self.ctx.scheduler.turn(self.transport_buffered) {
                let payload = frame.len().saturating_sub(FRAME_HEADER_LEN);
                if let Some(dl) = self.reqs.get_mut(&id).and_then(|r| r.download.as_mut()) {
                    dl.written = (dl.written + payload).min(dl.bytes.len());
                }
                out.push(Output::SendFrame(frame));
            }
        }
        out
    }

    fn advance(&mut self, now_ms: u64) {
        self.now = self.now.max(now_ms);
    }

    // ---- lifecycle -------------------------------------------------------

    /// Open the connection-owned `core.capabilities` stream (RFC 001 §2.2):
    /// once, right after the handshake selected the device plane and before
    /// any module callback can request device work. Returns its id.
    pub fn start(&mut self, now_ms: u64) -> Result<u32, LocalRefusal> {
        self.advance(now_ms);
        if self.closed {
            return Err(LocalRefusal::bare(DeviceErrorCode::ConnectionLost));
        }
        if self.started {
            return Err(LocalRefusal::new(
                DeviceErrorCode::Unsupported,
                "core.capabilities is already open",
            ));
        }
        if self.selected_version(CORE_CAPABILITIES) != Some(1) {
            return Err(LocalRefusal::new(
                DeviceErrorCode::Unsupported,
                "core.capabilities@1 was not negotiated",
            ));
        }
        self.started = true;
        self.open_core(self.now)
    }

    /// Planned reopen of the `core.capabilities` stream now: the old stream
    /// is retired first (cancel), then a fresh one opens under a new id.
    /// [`Self::tick`] does this on its own shortly before the deadline.
    pub fn reopen_core_capabilities(&mut self, now_ms: u64) -> Option<u32> {
        self.advance(now_ms);
        if self.closed || !self.started {
            return None;
        }
        self.core_reopen_at = None;
        if let Some(old) = self.core_id.take() {
            if let Some(mut req) = self.reqs.remove(&old) {
                self.ctx.send_control(old, Control::Cancel { cancel: true });
                self.ctx.release(std::mem::take(&mut req.reserved_bytes));
            }
        }
        self.open_core(self.now).ok()
    }

    fn open_core(&mut self, now: u64) -> Result<u32, LocalRefusal> {
        let rev = self
            .revision(CORE_CAPABILITIES, 1)
            .ok_or_else(|| LocalRefusal::bare(DeviceErrorCode::Unsupported))?;
        let timeout = self
            .config
            .control_stream_timeout_ms
            .clamp(1, rev.max_timeout_ms.max(1));
        let credit = self
            .config
            .control_stream_initial_credit
            .clamp(1, rev.max_initial_credit.max(1));
        let id = self.allocate_id()?;
        let lead = CONTROL_STREAM_REOPEN_LEAD_MS.min(timeout / 10);
        self.core_reopen_at = Some(now.saturating_add((timeout - lead).max(1)));
        self.core_id = Some(id);
        self.insert_request(
            id,
            CORE_CAPABILITIES.to_string(),
            1,
            rev,
            ReqOwner::Connection,
            Lifetime::Connection,
            timeout,
            credit,
            json!({}),
            None,
            false,
            true,
            now,
        );
        Ok(id)
    }

    /// Record that `module_instance_id` became active as `activation_id`
    /// (strictly increasing per module instance). The previous activation's
    /// authority ends: its activation-owned work is swept. Returns false —
    /// changing nothing — for a stale or non-increasing activation, or a
    /// destroyed module instance.
    pub fn owner_activated(
        &mut self,
        module_instance_id: &str,
        activation_id: u32,
        now_ms: u64,
    ) -> bool {
        self.advance(now_ms);
        let len = module_instance_id.chars().count();
        if activation_id == 0
            || len == 0
            || len > crate::serialize::device::limits::MODULE_INSTANCE_ID_MAX
        {
            return false;
        }
        let state = self
            .activations
            .entry(module_instance_id.to_string())
            .or_default();
        if state.destroyed || activation_id <= state.highest {
            return false;
        }
        let previous = state.active.replace(activation_id);
        state.highest = activation_id;
        if let Some(prev) = previous {
            self.sweep(module_instance_id, Some(prev));
        }
        true
    }

    /// The activation ended (module left the active slot): its
    /// activation-owned requests are cancelled; background work survives.
    pub fn owner_deactivated(&mut self, module_instance_id: &str, activation_id: u32, now_ms: u64) {
        self.advance(now_ms);
        if let Some(state) = self.activations.get_mut(module_instance_id) {
            if state.active == Some(activation_id) {
                state.active = None;
            }
        }
        self.sweep(module_instance_id, Some(activation_id));
    }

    /// The module instance was destroyed: every activation's work and its
    /// background work are cancelled, and it can never be activated again.
    pub fn owner_destroyed(&mut self, module_instance_id: &str, now_ms: u64) {
        self.advance(now_ms);
        let state = self
            .activations
            .entry(module_instance_id.to_string())
            .or_default();
        state.active = None;
        state.destroyed = true;
        self.sweep(module_instance_id, None);
    }

    fn sweep(&mut self, module_instance_id: &str, activation_id: Option<u32>) {
        let hit: Vec<u32> = self
            .reqs
            .values()
            .filter(|r| r.owner.swept_by(module_instance_id, activation_id))
            .map(|r| r.id)
            .collect();
        for id in hit {
            self.terminate(id, Term::code(DeviceErrorCode::Cancelled));
        }
        let draining: Vec<u32> = self
            .draining
            .values()
            .filter(|r| r.owner.swept_by(module_instance_id, activation_id))
            .map(|r| r.id)
            .collect();
        for id in draining {
            self.abort_drain(id, Outcome::err(DeviceErrorCode::Cancelled));
        }
    }

    /// Connection loss / teardown: every live request settles locally with
    /// `code` (nothing is sent), draining streams are abandoned, held
    /// results are released and the bulk queue is dropped.
    pub fn close(&mut self, code: DeviceErrorCode) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.core_reopen_at = None;
        let ids: Vec<u32> = self.reqs.keys().copied().collect();
        for id in ids {
            self.finish(id, Outcome::err(code));
        }
        let draining: Vec<u32> = self.draining.keys().copied().collect();
        for id in draining {
            self.abort_drain(id, Outcome::err(code));
        }
        let held: Vec<u64> = std::mem::take(&mut self.held).into_values().collect();
        for charge in held {
            self.ctx.release(charge);
        }
        self.ctx.scheduler.close();
        self.core_id = None;
    }

    /// The broker itself ends the device plane: close, then ask the host to
    /// reset the socket.
    fn close_plane(&mut self, reason: &str) {
        if self.closed {
            return;
        }
        self.close(DeviceErrorCode::ConnectionLost);
        self.ctx.outputs.push_back(Output::CloseConnection {
            code: DEVICE_PLANE_CLOSE_CODE,
            reason: truncate(&format!("device plane closed: {reason}"), CLOSE_REASON_MAX),
        });
    }

    // ---- opening requests ------------------------------------------------

    fn allocate_id(&mut self) -> Result<u32, LocalRefusal> {
        if self.next_id >= self.config.request_id_limit {
            self.close_plane("request id space exhausted");
            return Err(LocalRefusal::new(
                DeviceErrorCode::ConnectionLost,
                "request id space exhausted — connection must reset",
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        Ok(id)
    }

    /// Open a request for a handler (RFC 001 §4). Validates everything
    /// against the live selection and the selected revision before anything
    /// is sent; a refusal sends nothing. On success the `deviceRequest` and
    /// `renewLease` 1 are queued and the id is returned; its outcome arrives
    /// as exactly one [`Output::Settled`].
    pub fn open(&mut self, spec: OpenSpec, now_ms: u64) -> Result<u32, LocalRefusal> {
        use DeviceErrorCode as E;
        self.advance(now_ms);
        let now = self.now;
        if spec.replayed {
            return Err(LocalRefusal::new(E::Unavailable, "syncActions.replay"));
        }
        if self.closed {
            return Err(LocalRefusal::bare(E::ConnectionLost));
        }
        if !self.started {
            return Err(LocalRefusal::new(
                E::Unavailable,
                "device plane not started",
            ));
        }
        let cap = spec.capability.as_str();
        let Some(selected) = self.selected_version(cap) else {
            return Err(LocalRefusal::bare(E::Unsupported));
        };
        let version = spec.version.unwrap_or(selected);
        if version != selected {
            return Err(LocalRefusal::new(
                E::Unsupported,
                format!("{cap} v{version} is not the selected revision"),
            ));
        }
        let Some(rev) = self.revision(cap, version) else {
            return Err(LocalRefusal::bare(E::Unsupported));
        };
        let module = spec.module_instance_id.clone();
        if !self.owner_is_active(&module, spec.activation_id) {
            return Err(LocalRefusal::new(E::Unavailable, "owner-inactive"));
        }

        // Lifetime and owner (§2.7).
        let lifetime = spec.lifetime.unwrap_or_else(|| {
            rev.lifetimes
                .first()
                .copied()
                .unwrap_or(Lifetime::Activation)
        });
        let owner = match lifetime {
            Lifetime::Connection => {
                return Err(LocalRefusal::new(
                    E::Unsupported,
                    "lifetime \"connection\" is reserved for protocol control",
                ))
            }
            Lifetime::Background => {
                if !rev.lifetimes.contains(&Lifetime::Background) {
                    return Err(LocalRefusal::new(
                        E::Unsupported,
                        format!("lifetime \"background\" is not allowed by {cap} v{version}"),
                    ));
                }
                if !self.admits_background(&module) {
                    return Err(LocalRefusal::new(
                        E::Throttled,
                        format!(
                            "background pin cap reached ({} modules)",
                            self.config.max_background_owners
                        ),
                    ));
                }
                ReqOwner::Background { module }
            }
            Lifetime::Activation => {
                if !rev.lifetimes.contains(&Lifetime::Activation) {
                    return Err(LocalRefusal::new(
                        E::Unsupported,
                        format!("lifetime \"activation\" is not allowed by {cap} v{version}"),
                    ));
                }
                ReqOwner::Activation {
                    module,
                    activation: spec.activation_id,
                }
            }
        };

        // Operation shape.
        if rev.data == DataPlane::BinaryDownload && spec.download.is_none() {
            return Err(LocalRefusal::new(
                E::InvalidParams,
                format!("{cap} carries server→client bytes; use save()"),
            ));
        }
        if spec.download.is_some() && rev.data != DataPlane::BinaryDownload {
            return Err(LocalRefusal::new(
                E::InvalidParams,
                format!("{cap} carries no server→client bytes"),
            ));
        }
        match (spec.mode, rev.mode) {
            (Some(Mode::Unary), Mode::Stream) => {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    format!("{cap} is a stream; use stream()"),
                ))
            }
            (Some(Mode::Stream), Mode::Unary) => {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    format!("{cap} is not a stream; use request()"),
                ))
            }
            _ => {}
        }
        if rev.mode == Mode::Stream && !server_consumes(&rev) {
            return Err(LocalRefusal::new(
                E::InvalidParams,
                format!("{cap} streams nothing a server can consume"),
            ));
        }

        // Deadline and credit (§2.1/§2.3): clamped to the revision.
        let timeout = spec
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(rev.max_timeout_ms)
            .max(1);
        let credit = match rev.data {
            DataPlane::None | DataPlane::BinaryDownload => 0,
            DataPlane::JsonEvents | DataPlane::BinaryUpload => {
                if spec.initial_credit == Some(0) {
                    if !spec.allow_zero_credit {
                        return Err(LocalRefusal::new(
                            E::InvalidParams,
                            format!(
                                "initialCredit must be ≥ 1 for {cap} (a zero budget can never make progress)"
                            ),
                        ));
                    }
                    0
                } else {
                    let wanted =
                        spec.initial_credit
                            .unwrap_or(if rev.data == DataPlane::BinaryUpload {
                                DEFAULT_UPLOAD_INITIAL_CREDIT
                            } else {
                                DEFAULT_STREAM_INITIAL_CREDIT
                            });
                    wanted.min(rev.max_initial_credit).max(1)
                }
            }
        };

        // Download announcement: the params must describe exactly the bytes.
        if let Some(bytes) = &spec.download {
            if bytes.is_empty() {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    format!("{cap} needs at least 1 byte"),
                ));
            }
            if bytes.len() as u64 > rev.max_item_bytes {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    format!(
                        "{} bytes exceeds max item bytes {}",
                        bytes.len(),
                        rev.max_item_bytes
                    ),
                ));
            }
        }
        if let Err(why) = validate_payload(cap, version, PayloadKind::Params, &spec.params) {
            return Err(LocalRefusal::new(E::InvalidParams, format!("params {why}")));
        }
        if let Some(bytes) = &spec.download {
            let declared = spec.params.get("bytes").and_then(Value::as_u64);
            if declared != Some(bytes.len() as u64) {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    "params.bytes does not match the download",
                ));
            }
            if spec.params.get("sha256").and_then(Value::as_str) != Some(sha256_hex(bytes).as_str())
            {
                return Err(LocalRefusal::new(
                    E::InvalidParams,
                    "params.sha256 does not match the download",
                ));
            }
        }

        let id = self.allocate_id()?;
        self.insert_request(
            id,
            spec.capability,
            version,
            rev,
            owner,
            lifetime,
            timeout,
            credit,
            spec.params,
            spec.download,
            spec.hold_result,
            false,
            now,
        );
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_request(
        &mut self,
        id: u32,
        capability: String,
        version: u32,
        rev: CapabilityRevision,
        owner: ReqOwner,
        lifetime: Lifetime,
        timeout_ms: u64,
        initial_credit: u64,
        params: Value,
        download: Option<Vec<u8>>,
        hold_result: bool,
        core: bool,
        now: u64,
    ) {
        let json_stream = rev.data == DataPlane::JsonEvents;
        let upload = rev.data == DataPlane::BinaryUpload;
        let max_count = params.get("maxCount").and_then(Value::as_u64);
        let max_channels = max_count.map_or(u64::from(rev.max_items), |m| {
            m.min(u64::from(rev.max_items))
        });
        let message = DeviceMessage::DeviceRequest(DeviceRequest {
            id,
            capability: capability.clone(),
            version,
            owner: owner.wire(),
            lifetime,
            timeout_ms,
            initial_credit,
            params: params.clone(),
        });
        let req = Request {
            id,
            capability,
            version,
            owner,
            rev,
            params,
            core,
            hold_result,
            opened_at: now,
            timeout_ms,
            next_renew_at: now.saturating_add(LEASE_RENEW_INTERVAL_MS),
            lease_seq: 0,
            acked_seq: 0,
            last_progress: now,
            reserved_bytes: 0,
            event_credit: if json_stream { initial_credit } else { 0 },
            event_grant_batch: (initial_credit / 2).max(1),
            event_consumed: 0,
            events_unconsumed: 0,
            event_bucket: TokenBucket::new(
                self.config.event_rate.request_burst,
                self.config.event_rate.request_per_second,
                now,
            ),
            max_channels,
            upload_credit: if upload { initial_credit } else { 0 },
            upload_consumed: 0,
            upload_grant_batch: (initial_credit / 2).max(1),
            upload_window: if upload {
                rev.max_outstanding_credit
                    .min(initial_credit.max(MAX_BULK_CHUNK_BYTES as u64))
            } else {
                0
            },
            channels: BTreeMap::new(),
            streamed: upload && rev.mode == Mode::Stream,
            data_queue: VecDeque::new(),
            drain: None,
            download: download.map(|bytes| Download {
                bytes,
                offset: 0,
                written: 0,
                seq: 0,
                credit: 0,
            }),
            paused: false,
            progress: None,
            data_seen: false,
        };
        self.reqs.insert(id, req);
        self.ctx.send(message);
        // Lease seq 1 immediately after the request (§2.7), then on a fixed
        // 5 s cadence from the open.
        self.renew(id);
    }

    fn renew(&mut self, id: u32) {
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        if req.lease_seq == u32::MAX {
            // Lease sequences are u32 and never wrap: terminate first.
            self.terminate(id, Term::code(DeviceErrorCode::ConnectionLost));
            return;
        }
        req.lease_seq += 1;
        let seq = req.lease_seq;
        self.ctx
            .send_control(id, Control::RenewLease { renew_lease: seq });
    }

    /// Server-initiated cancellation (caller abandon, handler scope end):
    /// `cancel` is sent, the id retires and the request settles
    /// `cancelled`. A draining stream is abandoned. Unknown ids are ignored.
    pub fn cancel(&mut self, id: u32, now_ms: u64) {
        self.advance(now_ms);
        if self.core_id == Some(id) {
            return; // broker-owned; retired only by a planned reopen
        }
        self.terminate(id, Term::code(DeviceErrorCode::Cancelled));
    }

    /// Release a held result's retained-bytes charge (idempotent).
    pub fn release_result(&mut self, id: u32) {
        if let Some(charge) = self.held.remove(&id) {
            self.ctx.release(charge);
        }
    }

    // ---- termination -----------------------------------------------------

    /// Terminate a live request (sending `cancel` when `term.notify`), or
    /// abandon a draining one.
    fn terminate(&mut self, id: u32, term: Term) {
        if self.reqs.contains_key(&id) {
            if term.notify {
                self.ctx.send_control(id, Control::Cancel { cancel: true });
            }
            self.finish(id, term.outcome);
        } else if self.draining.contains_key(&id) {
            self.abort_drain(id, term.outcome);
        }
    }

    fn settle(&mut self, req: &Request, outcome: Outcome) {
        if req.core {
            return;
        }
        self.ctx.outputs.push_back(Output::Settled {
            id: req.id,
            outcome,
        });
    }

    /// Retire a live request with `outcome` (no wire traffic).
    fn finish(&mut self, id: u32, outcome: Outcome) {
        let Some(mut req) = self.reqs.remove(&id) else {
            return;
        };
        if req.download.is_some() {
            self.ctx.scheduler.discard(id);
        }
        if req.streamed {
            if outcome.is_ok() && !req.data_queue.is_empty() {
                // A streamed success settles once every accepted chunk was
                // consumed; the retired id keeps its charges meanwhile.
                req.drain = Some((outcome, self.now));
                self.draining.insert(id, req);
                return;
            }
            req.data_queue.clear();
        }
        let charged = std::mem::take(&mut req.reserved_bytes);
        let core_ended = req.core && self.core_id == Some(id);
        match outcome {
            Outcome::Err { .. } => {
                req.channels.clear();
                self.ctx.release(charged);
                self.settle(&req, outcome);
            }
            Outcome::Ok {
                result,
                blobs,
                simulated,
                ..
            } => {
                let held = req.hold_result && charged > 0 && !self.closed;
                if held {
                    self.held.insert(id, charged);
                } else {
                    self.ctx.release(charged);
                }
                self.settle(
                    &req,
                    Outcome::Ok {
                        result,
                        blobs,
                        simulated,
                        held,
                    },
                );
            }
        }
        if core_ended {
            // The mandatory control stream ended without a planned reopen.
            self.core_id = None;
            self.core_reopen_at = None;
            if !self.closed {
                self.close_plane("core.capabilities ended");
            }
        }
    }

    /// Abandon a draining streamed upload: nothing more is delivered, every
    /// charge it still holds is released and it settles with `outcome`.
    fn abort_drain(&mut self, id: u32, outcome: Outcome) {
        let Some(mut req) = self.draining.remove(&id) else {
            return;
        };
        req.data_queue.clear();
        req.drain = None;
        let charged = std::mem::take(&mut req.reserved_bytes);
        self.ctx.release(charged);
        self.settle(&req, outcome);
    }

    // ---- connection-level violations -------------------------------------

    /// Count a connection-level protocol violation (decisions D3/D8): the
    /// offending data is discarded and no request is touched. Past the
    /// tolerated burst the broker closes the device plane.
    fn connection_violation(&mut self, reason: String) {
        if self.closed {
            return;
        }
        self.connection_violations += 1;
        let reason = truncate(&reason, VIOLATION_REASON_MAX);
        self.last_connection_violation = Some(reason);
        if !self.violation_bucket.take(self.now) {
            self.close_plane("repeated protocol violations");
        }
    }

    /// A connection-level violation the host detected itself before
    /// feeding anything (e.g. over-limit device text it refused to parse or
    /// copy, see [`is_oversize_device_text`]): counted like the broker's own
    /// (decisions D3/D8); past the tolerated burst the plane closes.
    pub fn report_connection_violation(&mut self, reason: &str, now_ms: u64) {
        self.advance(now_ms);
        self.connection_violation(reason.to_string());
    }

    // ---- incoming text ---------------------------------------------------

    /// Feed one client → server device text message (the raw text: the JSON
    /// limits of RFC 001 §2.1 need it). Every message is strictly decoded
    /// before anything reads it:
    /// - JSON-limit breaches and unattributable messages are connection-level
    ///   violations: counted, never terminating a request;
    /// - unknown/retired ids are ignored whatever the message says;
    /// - a known-id invalid message terminates that request `invalidParams`
    ///   (`cancel` sent, unless the message was the client's terminal).
    ///
    /// Returns true when the message was for a live request.
    pub fn on_text(&mut self, text: &str, now_ms: u64) -> bool {
        self.advance(now_ms);
        if self.closed {
            return false;
        }
        let value = match parse_strict_json(text) {
            Ok(v) => v,
            Err(e) => {
                self.connection_violation(format!("device message outside the JSON limits: {e}"));
                return false;
            }
        };
        let msg = match DeviceMessage::decode_value(&value) {
            Ok(m) => m,
            Err(e) => {
                return match attribute_invalid(&value) {
                    None => {
                        self.connection_violation(format!("unattributable device message: {e}"));
                        false
                    }
                    Some((kind, id)) => {
                        if !self.reqs.contains_key(&id) {
                            return false; // unknown/stale → ignore, never a violation
                        }
                        let what = match kind {
                            MessageKind::Request => "deviceRequest",
                            MessageKind::Response => "deviceResponse",
                            MessageKind::Event => "deviceEvent",
                        };
                        let detail = format!("malformed {what}: {e}");
                        // A malformed terminal already retired the id on the
                        // client: settle locally, send nothing.
                        let term = if kind == MessageKind::Response {
                            Term::quiet_violation(detail)
                        } else {
                            Term::violation(detail)
                        };
                        self.terminate(id, term);
                        true
                    }
                };
            }
        };
        let id = msg.id();
        if !self.reqs.contains_key(&id) {
            return false; // liveness before direction
        }
        match msg {
            DeviceMessage::DeviceResponse(res) => self.receive_response(res),
            DeviceMessage::DeviceEvent(ev) => match (ev.control, ev.event) {
                (Some(control), _) => self.receive_control(id, control),
                (None, Some(event)) => self.receive_event(id, event),
                (None, None) => {}
            },
            DeviceMessage::DeviceRequest(_) => {
                self.terminate(id, Term::violation("deviceRequest from the client"))
            }
        }
        true
    }

    fn receive_response(&mut self, res: DeviceResponse) {
        let id = res.id;
        if let Some(DeviceError {
            code,
            platform_detail,
        }) = res.error
        {
            // Includes `revoked`, mid-stream or not; buffered bytes are
            // discarded with the request.
            self.finish(
                id,
                Outcome::Err {
                    code,
                    detail: platform_detail,
                },
            );
            return;
        }
        let Some(result) = res.result else {
            return;
        };
        let Some(req) = self.reqs.get(&id) else {
            return;
        };
        // Validated against the selected revision before anything sees it.
        if let Err(why) =
            validate_payload(&req.capability, req.version, PayloadKind::Result, &result)
        {
            self.terminate(id, Term::quiet_violation(format!("result {why}")));
            return;
        }
        if let Err(why) = check_result(req, &result) {
            self.terminate(id, Term::quiet_violation(why));
            return;
        }
        let blobs = collect_blobs(self.reqs.get_mut(&id).expect("live"), &result);
        self.finish(
            id,
            Outcome::Ok {
                result,
                blobs,
                simulated: res.simulated,
                held: false,
            },
        );
    }

    fn receive_control(&mut self, id: u32, control: Control) {
        let now = self.now;
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        match control {
            Control::LeaseAck { lease_ack } => {
                // Expiry is checked before processing a queued ack (§2.7).
                if now.saturating_sub(req.last_progress) >= LEASE_EXPIRY_MS {
                    self.terminate(id, Term::code(DeviceErrorCode::ConnectionLost));
                    return;
                }
                if lease_ack > req.lease_seq {
                    let latest = req.lease_seq;
                    self.terminate(
                        id,
                        Term::violation(format!(
                            "leaseAck {lease_ack} for a renewal never sent on request {id} (latest {latest})"
                        )),
                    );
                    return;
                }
                // Repeated/older acks do not refresh liveness.
                if lease_ack > req.acked_seq {
                    req.acked_seq = lease_ack;
                    req.last_progress = now;
                }
            }
            Control::Grant { grant } => {
                let max = req.rev.max_outstanding_credit;
                let Some(dl) = req.download.as_mut() else {
                    // Only a server → client data plane takes client grants.
                    self.terminate(
                        id,
                        Term::violation("grant on a request whose data flows client→server"),
                    );
                    return;
                };
                if dl.credit + grant > max {
                    self.terminate(
                        id,
                        Term::violation(format!("grant overflows max outstanding credit {max}")),
                    );
                    return;
                }
                dl.credit += grant;
                self.pump_download(id);
            }
            Control::Paused { paused } => {
                // Backpressure status travels data sender → receiver.
                let data = req.rev.data;
                if req.download.is_some()
                    || !matches!(data, DataPlane::BinaryUpload | DataPlane::JsonEvents)
                {
                    self.terminate(id, Term::violation("wrong-direction control: paused"));
                    return;
                }
                if paused == req.paused {
                    self.terminate(
                        id,
                        Term::violation(format!("paused:{paused} repeats the current state")),
                    );
                    return;
                }
                req.paused = paused;
                if paused {
                    if let Some(grant) = top_up_window(req) {
                        self.ctx.send_control(id, Control::Grant { grant });
                    }
                }
            }
            Control::Cancel { .. } => {
                self.terminate(id, Term::violation("wrong-direction control: cancel"))
            }
            Control::RenewLease { .. } => {
                self.terminate(id, Term::violation("wrong-direction control: renewLease"))
            }
        }
    }

    fn receive_event(&mut self, id: u32, event: Value) {
        let now = self.now;
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        // Every capability event is validated against the selected
        // revision's event schema before anything reads it.
        let typed = match decode_event(&req.capability, req.version, &event) {
            Ok(t) => t,
            Err(why) => {
                self.terminate(id, Term::violation(format!("event {why}")));
                return;
            }
        };
        // Token buckets bound the event rate independently of credit (§2.3).
        if !req.event_bucket.take(now) || !self.ctx.connection_events.take(now) {
            self.terminate(id, Term::throttled("event rate limit"));
            return;
        }
        if let TypedEvent::Progress(p) = &typed {
            // Optional, but progress never goes back (§2.1).
            if p.state == ProgressState::PendingConsent
                && (req.progress == Some(ProgressState::Running) || req.data_seen)
            {
                self.terminate(id, Term::violation("progress went back to pendingConsent"));
                return;
            }
            req.progress = Some(p.state);
            return;
        }
        if req.rev.data == DataPlane::BinaryUpload && req.download.is_none() {
            match typed {
                TypedEvent::BlobStart(bs) => self.receive_blob_start(id, bs),
                _ => self.terminate(
                    id,
                    Term::violation(format!(
                        "unexpected event kind {}",
                        event.get("kind").map(Value::to_string).unwrap_or_default()
                    )),
                ),
            }
            return;
        }
        if req.rev.data != DataPlane::JsonEvents {
            let plane = format!("{:?}", req.rev.data);
            self.terminate(
                id,
                Term::violation(format!("capability event on a {plane} data plane")),
            );
            return;
        }
        if req.paused {
            self.terminate(
                id,
                Term::violation("stream event while the sender reported paused"),
            );
            return;
        }
        // JSON stream credit counts events (§2.3).
        if req.event_credit == 0 {
            self.terminate(id, Term::violation("event beyond granted event credit"));
            return;
        }
        req.event_credit -= 1;
        req.data_seen = true;
        if req.core {
            let TypedEvent::Capabilities(snapshot) = typed else {
                return;
            };
            self.apply_capabilities(&snapshot);
            if self.closed {
                return;
            }
            // The broker is the consumer: credit comes back at once.
            if let Some(req) = self.reqs.get_mut(&id) {
                if let Some(grant) = replenish_events(req, 1) {
                    self.ctx.send_control(id, Control::Grant { grant });
                }
            }
            return;
        }
        req.events_unconsumed += 1;
        self.ctx.outputs.push_back(Output::Event { id, event });
    }

    /// A `core.capabilities` snapshot (§2.2) replaces the live selection
    /// with the negotiated selection (the ack) restricted to the entries
    /// whose revision the snapshot still lists. The ack is the ceiling for
    /// the whole connection: a snapshot narrows the selection or restores
    /// an entry it withdrew, never widens it — not even to a capability
    /// this server advertises but the client's hello lacked, which every
    /// client refuses as `unsupported` until the next handshake.
    /// Withdrawing `core.capabilities` itself closes the device plane.
    fn apply_capabilities(&mut self, snapshot: &CapabilitiesEvent) {
        let next: Vec<(String, u32)> = self
            .negotiated
            .iter()
            .filter(|(name, version)| {
                snapshot
                    .capabilities
                    .iter()
                    .any(|o| o.name == *name && o.versions.contains(version))
            })
            .cloned()
            .collect();
        if !next.iter().any(|(n, v)| n == CORE_CAPABILITIES && *v == 1) {
            self.close_plane("core.capabilities withdrawn");
            return;
        }
        self.selection = next;
    }

    /// The host is done with `n` JSON stream events of request `id`: event
    /// credit is replenished (batched, never above `max_outstanding_credit`).
    ///
    /// `n` is a host-supplied count, so it is clamped to the events this
    /// broker actually handed out as [`Output::Event`] for `id` and not yet
    /// reported consumed: over-reporting (10 after 0 deliveries, `u64::MAX`)
    /// earns no credit, and the call is O(1) whatever `n` is. Several events
    /// consumed at once come back as at most one grant.
    pub fn consumed_events(&mut self, id: u32, n: u64, now_ms: u64) {
        self.advance(now_ms);
        if self.closed {
            return;
        }
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        let n = n.min(req.events_unconsumed);
        if n == 0 {
            return;
        }
        req.events_unconsumed -= n;
        if let Some(grant) = replenish_events(req, n) {
            self.ctx.send_control(id, Control::Grant { grant });
        }
    }

    /// The host is done with the next `chunks` [`Output::Data`] chunks of
    /// stream `id` (in order): their budget charge is released and upload
    /// credit replenished; a draining success settles once all are consumed.
    ///
    /// `chunks` is clamped to the chunks handed out and not yet consumed, so
    /// over-reporting (`usize::MAX`) releases nothing extra and returns after
    /// at most that many (already delivered) chunks; several chunks consumed
    /// at once come back as at most one grant.
    pub fn consumed_data(&mut self, id: u32, chunks: usize, now_ms: u64) {
        self.advance(now_ms);
        let now = self.now;
        if let Some(req) = self.reqs.get_mut(&id) {
            let n = chunks.min(req.data_queue.len());
            if n == 0 {
                return;
            }
            let (mut len, mut charge) = (0u64, 0u64);
            for chunk in req.data_queue.drain(..n) {
                len += chunk.len;
                charge += chunk.charge;
            }
            req.reserved_bytes = req.reserved_bytes.saturating_sub(charge);
            req.upload_consumed += len;
            self.ctx.release(charge);
            if let Some(grant) = replenish_upload(req, self.closed) {
                self.ctx.send_control(id, Control::Grant { grant });
            }
            // The sink caught up: a paused sender may resume (§2.3).
            if req.data_queue.is_empty() && !self.closed {
                if let Some(grant) = top_up_window(req) {
                    self.ctx.send_control(id, Control::Grant { grant });
                }
            }
        } else if let Some(req) = self.draining.get_mut(&id) {
            let n = chunks.min(req.data_queue.len());
            if n == 0 {
                return;
            }
            let charge: u64 = req.data_queue.drain(..n).map(|c| c.charge).sum();
            req.reserved_bytes = req.reserved_bytes.saturating_sub(charge);
            self.ctx.release(charge);
            if let Some((_, progress)) = req.drain.as_mut() {
                *progress = now;
            }
            if req.data_queue.is_empty() {
                let mut req = self.draining.remove(&id).expect("draining");
                let outcome = req.drain.take().map(|(o, _)| o).expect("drain outcome");
                let charged = std::mem::take(&mut req.reserved_bytes);
                self.ctx.release(charged);
                self.settle(&req, outcome);
            }
        }
    }

    fn receive_blob_start(&mut self, id: u32, bs: BlobStart) {
        let max_retained = self.ctx.max_retained;
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        let channel = bs.channel;
        if req.channels.contains_key(&channel) {
            self.terminate(
                id,
                Term::violation(format!("blobStart: duplicate channel {channel}")),
            );
            return;
        }
        if validate_blob_start_for_request(&req.capability, req.version, &req.params, &bs).is_err()
        {
            let ct: String = serde_json::to_string(&bs.content_type)
                .unwrap_or_default()
                .chars()
                .take(80)
                .collect();
            self.terminate(
                id,
                Term::violation(format!(
                    "blobStart: contentType {ct} does not fit the request"
                )),
            );
            return;
        }
        if u64::from(channel) >= req.max_channels
            || req.channels.len() as u64 + 1 > req.max_channels
        {
            let max = req.max_channels;
            self.terminate(
                id,
                Term::violation(format!(
                    "blobStart: channel {channel} outside the {max} items this request allows"
                )),
            );
            return;
        }
        // A declared size above the item cap is refused before any sink.
        if let Some(bytes) = bs.bytes {
            if bytes > req.rev.max_item_bytes {
                let max = req.rev.max_item_bytes;
                self.terminate(
                    id,
                    Term::violation(format!(
                        "blobStart: {bytes} bytes exceeds max item bytes {max}"
                    )),
                );
                return;
            }
        }
        // A declaration reserves its size up front (§2.4 step 3 / §5); a
        // streamed upload retains nothing beyond unconsumed chunks.
        let streamed = req.streamed;
        if let Some(bytes) = bs.bytes {
            if !streamed && !self.ctx.reserve(req, bytes) {
                self.terminate(
                    id,
                    Term::throttled(format!("connection byte budget {max_retained} exceeded")),
                );
                return;
            }
        }
        req.data_seen = true;
        req.channels.insert(
            channel,
            Channel {
                content_type: bs.content_type,
                declared: bs.bytes,
                received: 0,
                seq: ChannelSeq::default(),
                buf: Vec::new(),
                capacity: 0,
                frame_charge: 0,
                charged: if streamed { 0 } else { bs.bytes.unwrap_or(0) },
                hash: Sha256::new(),
            },
        );
    }

    fn pump_download(&mut self, id: u32) {
        let Some(req) = self.reqs.get_mut(&id) else {
            return;
        };
        let Some(dl) = req.download.as_mut() else {
            return;
        };
        let total = dl.bytes.len();
        while dl.offset < total && dl.credit > 0 {
            let n = MAX_BULK_CHUNK_BYTES
                .min(usize::try_from(dl.credit).unwrap_or(usize::MAX))
                .min(total - dl.offset);
            if dl.seq > u64::from(u32::MAX) {
                self.terminate(id, Term::violation("download seq exhausted"));
                return;
            }
            let header = FrameHeader {
                version: FRAME_VERSION,
                flags: 0,
                channel: 0,
                request_id: id,
                seq: dl.seq as u32,
            };
            let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + n);
            frame.extend_from_slice(&header.encode());
            frame.extend_from_slice(&dl.bytes[dl.offset..dl.offset + n]);
            if !self.ctx.scheduler.enqueue(id, frame) {
                self.terminate(id, Term::throttled("bulk queue bound reached"));
                return;
            }
            dl.offset += n;
            dl.seq += 1;
            dl.credit -= n as u64;
        }
    }

    // ---- incoming frames -------------------------------------------------

    /// Feed one client → server binary frame (RFC 001 §2.3/§2.4).
    ///
    /// A frame shorter than the header is dropped. An unknown version or
    /// nonzero flags is a connection-level violation (decision D3). Unknown
    /// or retired ids allocate nothing. For a live request the frame must be
    /// on a channel announced by `blobStart`, carry the channel's next
    /// `seq`, a non-empty payload of at most 64 KiB, fit the outstanding
    /// credit, the declaration and the revision's `max_item_bytes`, and not
    /// arrive while the sender reported `paused`; any violation cancels the
    /// request `invalidParams`. Exceeding the retained-bytes budgets
    /// terminates it `throttled`. Returns true when the frame was accepted.
    pub fn on_frame(&mut self, frame: &[u8], now_ms: u64) -> bool {
        self.advance(now_ms);
        if self.closed {
            return false;
        }
        let (header, payload) = match FrameHeader::decode(frame) {
            Ok(v) => v,
            Err(FrameError::ShortHeader) => return false,
            Err(FrameError::Violation) => {
                let detail = if frame[0] != FRAME_VERSION {
                    format!("version {}", frame[0])
                } else {
                    format!("flags {}", frame[1])
                };
                self.connection_violation(format!("bad frame header: {detail}"));
                return false;
            }
        };
        let id = header.request_id;
        let channel = header.channel;
        let len = payload.len() as u64;
        let min_charge = self.ctx.min_frame_charge;
        let Some(req) = self.reqs.get_mut(&id) else {
            return false; // unknown/stale id → no storage
        };
        let term = (|| -> Result<(), Term> {
            if req.download.is_some() || req.rev.data != DataPlane::BinaryUpload {
                return Err(Term::violation(format!(
                    "frame on channel {channel}: request has no client→server data plane"
                )));
            }
            if req.paused {
                return Err(Term::violation(format!(
                    "channel {channel}: data while the sender reported paused"
                )));
            }
            let overflow = req.rev.overflow;
            let max_item = req.rev.max_item_bytes;
            let Some(ch) = req.channels.get_mut(&channel) else {
                return Err(Term::violation(format!(
                    "frame on channel {channel} before blobStart"
                )));
            };
            let expected = ch.seq.expected();
            if !ch.seq.accept(overflow, header.seq) {
                let want = match (expected, overflow) {
                    (None, _) => "nothing after u32::MAX (wrap)".to_string(),
                    (Some(e), Overflow::DropOldest) => format!(">= {e}"),
                    (Some(e), _) => e.to_string(),
                };
                return Err(Term::violation(format!(
                    "channel {channel}: seq {}, expected {want}",
                    header.seq
                )));
            }
            if len == 0 {
                // A zero-length frame carries nothing and consumes no credit;
                // a zero-byte item sends no frames at all (decision D2).
                return Err(Term::violation(format!(
                    "channel {channel}: zero-length frame"
                )));
            }
            if len > MAX_BULK_CHUNK_BYTES as u64 {
                return Err(Term::violation(format!(
                    "channel {channel}: chunk of {len} bytes above {MAX_BULK_CHUNK_BYTES}"
                )));
            }
            if len > req.upload_credit {
                return Err(Term::violation(format!(
                    "frame of {len} bytes exceeds outstanding credit {}",
                    req.upload_credit
                )));
            }
            let total = ch.received + len;
            if let Some(declared) = ch.declared {
                if total > declared {
                    return Err(Term::violation(format!(
                        "channel {channel}: {total} bytes exceeds declared {declared}"
                    )));
                }
            }
            if total > max_item {
                return Err(Term::violation(format!(
                    "channel {channel}: exceeds max item bytes {max_item}"
                )));
            }
            Ok(())
        })();
        if let Err(term) = term {
            self.terminate(id, term);
            return false;
        }

        let req = self.reqs.get_mut(&id).expect("live");
        if req.streamed {
            // Streamed: charge the chunk until the host consumed it, hash it
            // and hand it on in order — nothing is retained here.
            let charge = len.max(min_charge);
            if !self.ctx.reserve(req, charge) {
                self.terminate(id, Term::throttled("retained byte budget exceeded"));
                return false;
            }
            let ch = req.channels.get_mut(&channel).expect("announced");
            ch.hash.update(payload);
            ch.received += len;
            req.data_seen = true;
            req.upload_credit -= len;
            req.data_queue.push_back(QueuedChunk { len, charge });
            self.ctx.outputs.push_back(Output::Data {
                id,
                channel,
                bytes: payload.to_vec(),
            });
            return true;
        }

        // Buffered: charge what the channel now really costs — its buffer
        // capacity (grown geometrically, capped at the declaration / item
        // cap), at least `min_frame_charge` per frame, at least the
        // declaration reserved at blobStart.
        let max_item = req.rev.max_item_bytes;
        let (need, capacity, frame_charge, charged) = {
            let ch = req.channels.get(&channel).expect("announced");
            let total = ch.received + len;
            let cap = ch.declared.unwrap_or(max_item);
            let capacity = if total <= ch.capacity {
                ch.capacity
            } else {
                cap.min(total.max(ch.capacity * 2).max(4096))
            };
            // The frame completing a declared item is charged exactly.
            let completes = ch.declared == Some(total);
            let frame_charge = ch.frame_charge + if completes { len } else { len.max(min_charge) };
            let need = ch.declared.unwrap_or(0).max(capacity).max(frame_charge);
            (need, capacity, frame_charge, ch.charged)
        };
        if need > charged {
            if !self.ctx.reserve(req, need - charged) {
                self.terminate(id, Term::throttled("retained byte budget exceeded"));
                return false;
            }
            req.channels.get_mut(&channel).expect("announced").charged = need;
        }
        let ch = req.channels.get_mut(&channel).expect("announced");
        ch.frame_charge = frame_charge;
        if capacity > ch.capacity {
            ch.buf
                .reserve_exact(usize::try_from(capacity).unwrap_or(usize::MAX) - ch.buf.len());
            ch.capacity = capacity;
        }
        ch.buf.extend_from_slice(payload);
        ch.hash.update(payload);
        ch.received += len;
        req.data_seen = true;
        req.upload_credit -= len;
        req.upload_consumed += len;
        if let Some(grant) = replenish_upload(req, false) {
            self.ctx.send_control(id, Control::Grant { grant });
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Per-request helpers
// ---------------------------------------------------------------------------

/// Replenish JSON event credit as the consumer frees `consumed` more events
/// (O(1) in `consumed`): batched (half the initial credit), immediately when
/// exhausted, never above `max_outstanding_credit`.
fn replenish_events(req: &mut Request, consumed: u64) -> Option<u64> {
    if consumed == 0 {
        return None;
    }
    req.event_consumed = req.event_consumed.saturating_add(consumed);
    if req.event_consumed < req.event_grant_batch && req.event_credit > 0 {
        return None;
    }
    let cap = req.rev.max_outstanding_credit;
    let grant = req.event_consumed.min(cap.saturating_sub(req.event_credit));
    req.event_consumed = 0;
    if grant == 0 {
        return None;
    }
    req.event_credit += grant;
    Some(grant)
}

/// Batched upload replenishment (§2.3): one grant per half window, not one
/// per frame, never letting outstanding credit exceed the revision bound.
fn replenish_upload(req: &mut Request, closed: bool) -> Option<u64> {
    if closed {
        return None;
    }
    if req.upload_consumed < req.upload_grant_batch && req.upload_credit != 0 {
        return None;
    }
    let room = req
        .rev
        .max_outstanding_credit
        .saturating_sub(req.upload_credit);
    let grant = req.upload_consumed.min(room);
    req.upload_consumed = 0;
    if grant == 0 {
        return None;
    }
    req.upload_credit += grant;
    Some(grant)
}

/// A paused sender on an upload plane: raise outstanding credit to the
/// request's window — only once the sink caught up (a streamed upload's
/// host consumed every chunk), so a slow consumer still backpressures.
fn top_up_window(req: &mut Request) -> Option<u64> {
    if req.rev.data != DataPlane::BinaryUpload || req.download.is_some() || !req.paused {
        return None;
    }
    if req.streamed && !req.data_queue.is_empty() {
        return None;
    }
    let target = req.upload_window.min(req.rev.max_outstanding_credit);
    let grant = target.saturating_sub(req.upload_credit);
    if grant == 0 {
        return None;
    }
    req.upload_credit += grant;
    req.upload_consumed = req.upload_consumed.saturating_sub(grant);
    Some(grant)
}

/// Blob items of a result: `items: [...]` or a single `item` (mic.record).
fn result_items(result: &Value) -> Vec<&Value> {
    if let Some(items) = result.get("items").and_then(Value::as_array) {
        return items.iter().collect();
    }
    match result.get("item") {
        Some(item) if item.is_object() => vec![item],
        _ => Vec::new(),
    }
}

/// A success terminal against what was announced and transferred (§2.4):
/// downloads report exactly the bytes that really left; uploads name exactly
/// the announced item set with matching content type, byte counts (actual =
/// received = declared when declared) and SHA-256 of the received bytes.
fn check_result(req: &Request, result: &Value) -> Result<(), String> {
    if let Some(dl) = &req.download {
        let total = dl.bytes.len() as u64;
        let written = result.get("bytesWritten").and_then(Value::as_u64);
        if written != Some(total) {
            let shown = result
                .get("bytesWritten")
                .map(Value::to_string)
                .unwrap_or_else(|| "undefined".into());
            return Err(format!("bytesWritten {shown} ≠ declared {total}"));
        }
        if dl.written != dl.bytes.len() {
            return Err(format!(
                "success after {} of {} bytes were sent",
                dl.written, total
            ));
        }
        return Ok(());
    }
    if req.rev.data != DataPlane::BinaryUpload {
        return Ok(());
    }
    let items = result_items(result);
    let mut seen = HashSet::new();
    for item in &items {
        let channel = item
            .get("channel")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        if !seen.insert(channel) {
            return Err(format!("result lists channel {channel} twice"));
        }
    }
    if items.len() != req.channels.len() {
        return Err(format!(
            "result declares {} items, blobStart announced {}",
            items.len(),
            req.channels.len()
        ));
    }
    for item in &items {
        let channel = item
            .get("channel")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        let Some(ch) = u16::try_from(channel)
            .ok()
            .and_then(|c| req.channels.get(&c))
        else {
            return Err(format!("result item on unannounced channel {channel}"));
        };
        if item.get("contentType").and_then(Value::as_str) != Some(ch.content_type.as_str()) {
            return Err(format!(
                "channel {channel}: result contentType differs from blobStart"
            ));
        }
        if let Some(declared) = ch.declared {
            if ch.received != declared {
                return Err(format!(
                    "channel {channel}: received {} of {declared} declared bytes",
                    ch.received
                ));
            }
        }
        let stated = item.get("bytes").and_then(Value::as_u64);
        if stated != Some(ch.received) {
            let shown = item.get("bytes").map(Value::to_string).unwrap_or_default();
            return Err(format!(
                "channel {channel}: result states {shown} bytes, received {}",
                ch.received
            ));
        }
        let actual = hex(&ch.hash.clone().finalize());
        if item.get("sha256").and_then(Value::as_str) != Some(actual.as_str()) {
            return Err(format!("channel {channel}: sha256 mismatch"));
        }
    }
    Ok(())
}

/// The verified items of a buffered upload, in result order (the buffers
/// move out of the request; nothing is copied).
fn collect_blobs(req: &mut Request, result: &Value) -> Vec<Blob> {
    if req.streamed || req.channels.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for item in result_items(result) {
        let Some(channel) = item
            .get("channel")
            .and_then(Value::as_u64)
            .and_then(|c| u16::try_from(c).ok())
        else {
            continue;
        };
        let Some(ch) = req.channels.get_mut(&channel) else {
            continue;
        };
        out.push(Blob {
            channel,
            name: item.get("name").and_then(Value::as_str).map(str::to_string),
            content_type: ch.content_type.clone(),
            bytes: std::mem::take(&mut ch.buf),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::device::CapabilitySelection;

    fn ack() -> DeviceAck {
        DeviceAck {
            protocol_version: 1,
            binary: true,
            capabilities: registry()
                .iter()
                .map(|c| CapabilitySelection {
                    name: c.name.to_string(),
                    version: 1,
                })
                .collect(),
        }
    }

    fn started() -> DeviceBroker {
        let mut b = DeviceBroker::new(BrokerConfig::new(ack()), 0);
        b.start(0).unwrap();
        assert!(b.owner_activated("m1", 1, 0));
        b.poll();
        b
    }

    fn texts(out: &[Output]) -> Vec<Value> {
        out.iter()
            .filter_map(|o| match o {
                Output::SendText(t) => Some(serde_json::from_str(t).unwrap()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn renew_lease_sequence_never_wraps() {
        let mut b = started();
        let id = b
            .open(
                OpenSpec::new(
                    "permission.request",
                    json!({"permission": "camera"}),
                    "m1",
                    1,
                ),
                0,
            )
            .unwrap();
        b.poll();
        {
            let req = b.reqs.get_mut(&id).unwrap();
            req.lease_seq = u32::MAX;
            req.acked_seq = u32::MAX;
        }
        // Keep the core stream acknowledged so only the request's lease acts.
        b.tick(5_000);
        let out = b.poll();
        assert!(out.iter().any(|o| matches!(
            o,
            Output::Settled { id: i, outcome } if *i == id && outcome.code() == Some(DeviceErrorCode::ConnectionLost)
        )));
        for m in texts(&out) {
            if m["id"] == id {
                assert!(
                    m["control"].get("renewLease").is_none(),
                    "no wrapped renewal: {m}"
                );
            }
        }
    }

    #[test]
    fn download_seq_exhaustion_terminates_the_request() {
        let mut b = started();
        let id = b
            .open(
                OpenSpec::save("a.bin", "application/octet-stream", vec![7; 10], "m1", 1),
                0,
            )
            .unwrap();
        b.poll();
        b.reqs.get_mut(&id).unwrap().download.as_mut().unwrap().seq = u64::from(u32::MAX) + 1;
        assert!(b.on_text(
            &format!(r#"{{"type":"deviceEvent","id":{id},"control":{{"grant":10}}}}"#),
            0
        ));
        let out = b.poll();
        assert!(out.iter().any(|o| matches!(
            o,
            Output::Settled { id: i, outcome: Outcome::Err { code: DeviceErrorCode::InvalidParams, detail: Some(d) } }
                if *i == id && d.contains("seq exhausted")
        )));
        assert!(!out.iter().any(|o| matches!(o, Output::SendFrame(_))));
    }

    #[test]
    fn oversize_scan_finds_type_anywhere_and_escaped() {
        let pad = "x".repeat(crate::serialize::device::limits::MESSAGE_MAX_BYTES);
        let a = format!(r#"{{"pad":"{pad}","type":"deviceEvent","id":1}}"#);
        assert!(is_oversize_device_text(&a));
        let b = format!(r#"{{ "type" : "deviceEvent", "pad":"{pad}"}}"#);
        assert!(is_oversize_device_text(&b));
        let c = format!(r#"{{"type":"patch","pad":"{pad}"}}"#);
        assert!(!is_oversize_device_text(&c));
        let d = format!(r#"{{"pad":"{pad}"}}"#);
        assert!(!is_oversize_device_text(&d));
        let e = format!(r#"{{"type":"patch","type":"deviceEvent","pad":"{pad}"}}"#);
        assert!(
            is_oversize_device_text(&e),
            "duplicated type is unscannable"
        );
        let f = format!(r#"["{pad}"]"#);
        assert!(is_oversize_device_text(&f), "not an object: unscannable");
        let g = format!(r#"{{"nested":{{"type":"deviceEvent"}},"pad":"{pad}"}}"#);
        assert!(!is_oversize_device_text(&g), "only top-level members count");
        assert!(
            !is_oversize_device_text(r#"{"type":"deviceEvent"}"#),
            "under the limit"
        );
        let h = format!(r#"{{"type":,"pad":"{pad}"}}"#);
        assert!(
            is_oversize_device_text(&h),
            "a member without a value is unscannable"
        );
        let i = format!(r#"{{"type" : "deviceResponse" , "pad":"{pad}" }}"#);
        assert!(is_oversize_device_text(&i));
    }

    #[test]
    fn top_level_member_text_extracts_exact_raw_values() {
        let hello = r#"{"type":"hello","props":{"device":1},"device":{"protocolVersions":[1],"binary":true,"capabilities":[]} }"#;
        assert_eq!(
            top_level_member_text(hello, "device"),
            Ok(Some(
                r#"{"protocolVersions":[1],"binary":true,"capabilities":[]}"#
            ))
        );
        // Nested members of the same name are not top-level.
        assert_eq!(
            top_level_member_text(r#"{"props":{"device":1}}"#, "device"),
            Ok(None)
        );
        // Escaped key spellings match after unescaping.
        assert_eq!(
            top_level_member_text(r#"{"device":null}"#, "device"),
            Ok(Some("null"))
        );
        // A repeated member is ambiguous: refused, never "first wins".
        assert_eq!(
            top_level_member_text(r#"{"device":{},"device":{}}"#, "device"),
            Err(())
        );
        assert_eq!(top_level_member_text("[1,2]", "device"), Err(()));
        assert_eq!(top_level_member_text("{not json", "device"), Err(()));
    }

    #[test]
    fn device_message_type_routes_only_device_types() {
        assert_eq!(
            device_message_type(r#"{"type":"deviceRequest","id":1}"#),
            Some("deviceRequest")
        );
        assert_eq!(
            device_message_type(r#"{"id":1,"type":"deviceEvent"}"#),
            Some("deviceEvent")
        );
        assert_eq!(
            device_message_type(r#"{"type":"deviceResponse"}"#),
            Some("deviceResponse")
        );
        assert_eq!(
            device_message_type(r#"{"type":"patch","patches":[]}"#),
            None
        );
        assert_eq!(device_message_type(r#"{"type":7}"#), None);
        assert_eq!(
            device_message_type(r#"{"type":"deviceRequest","type":"x"}"#),
            None
        );
        assert_eq!(device_message_type("garbage"), None);
    }
}
