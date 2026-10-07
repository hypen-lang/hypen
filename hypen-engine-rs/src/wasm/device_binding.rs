//! Binding-agnostic adapter over the sans-IO device broker
//! ([`crate::device::DeviceBroker`], RFC 001).
//!
//! Every binding surface — wasm-bindgen (`WasmDeviceBroker`, Node/Bun/
//! Cloudflare), the WASI C ABI (`hypen_device_*`, Go via wazero) and UniFFI
//! (`DeviceBroker`, Kotlin and the Swift server) — exposes the SAME broker
//! with the SAME JSON shapes. This module holds everything those surfaces
//! share so the shapes cannot drift between them:
//!
//! - [`OwnedBroker`]: the broker as every binding object holds it — dropping
//!   it (JS `free()`/GC, UniFFI release, WASI destroy) closes it and hands
//!   its retained bytes back to the shared pool;
//! - [`parse_config`]: the broker configuration JSON (below);
//! - [`parse_open_spec`]: the `open` request JSON;
//! - [`open_result_json`]: `{"id": n}` or `{"error": {"code", "detail"?}}`;
//! - [`outcome_parts`]: a settlement's JSON with its blob bytes split out;
//! - [`encode_framed`] / [`decode_framed`]: the WASI poll framing;
//! - [`info_json`]: a snapshot of the broker's queryable state;
//! - [`revision_json`]: the effective revision the broker enforces for one
//!   `capability@version`, and [`server_consumes_json`] over that shape;
//! - handshake helpers: [`handshake_json`] (validation + selection with a
//!   diagnostic — what a server SDK calls for `hello.device`),
//!   [`negotiate_json`], [`select_ack_json`],
//!   [`validate_hello_json`], [`validate_ack_json`],
//!   [`server_advertisement_json`], [`constants_json`].
//!
//! It is plain Rust (no platform code), compiled with the `device-broker`
//! feature (implied by `wasi` and `uniffi`; the browser JS bundle leaves it
//! out) and under `cargo test`, so the shapes are unit-tested natively.
//!
//! # Configuration JSON
//!
//! ```json
//! {
//!   "ack": {"protocolVersion": 1, "binary": true, "capabilities": [{"name": "core.capabilities", "version": 1}]},
//!   "serverCapabilities": [{"name": "gallery.pick", "versions": [1]}],
//!   "maxRetainedBytes": 134217728,
//!   "maxItemBytes": 67108864,
//!   "maxBackgroundOwners": 2,
//!   "minFrameCharge": 1024,
//!   "drainTimeoutMs": 30000,
//!   "eventRate": {"requestBurst": 256, "requestPerSecond": 128, "connectionBurst": 1024, "connectionPerSecond": 512},
//!   "violationRate": {"burst": 32, "perSecond": 1},
//!   "controlStreamTimeoutMs": 86400000,
//!   "controlStreamInitialCredit": 8,
//!   "scheduler": {"turnBytes": 65536, "pendingLimit": 262144, "maxQueuedBytes": 8388608, "retryMs": 10},
//!   "revisionOverrides": [{"capability": "bluetooth.scan", "version": 1, "lifetimes": ["activation", "background"]}],
//!   "requestIdLimit": 4294967295
//! }
//! ```
//!
//! Only `ack` is required (strictly decoded like `sessionAck.device`);
//! every other member defaults to [`BrokerConfig::new`]'s value. Unknown
//! members are rejected so a misspelt limit cannot silently fall back to a
//! default. `serverCapabilities` defaults to [`server_advertisement`].
//! A revision override starts from the shipped registry revision with that
//! name and version and may replace `lifetimes`, `maxItemBytes`,
//! `maxItems`, `maxInitialCredit`, `maxOutstandingCredit` and
//! `maxTimeoutMs` (the payload schemas stay the shipped ones).
//!
//! # Open JSON
//!
//! ```json
//! {
//!   "capability": "gallery.pick", "version": 1, "params": {"mediaTypes": ["photo"], "maxCount": 1},
//!   "moduleInstanceId": "m1", "activationId": 1,
//!   "lifetime": "activation", "timeoutMs": 60000, "initialCredit": 262144,
//!   "allowZeroCredit": false, "mode": "unary", "holdResult": false, "replayed": false
//! }
//! ```
//!
//! `capability`, `moduleInstanceId` and `activationId` are required;
//! `params` defaults to `{}`; the rest mirror [`OpenSpec`]'s optional
//! fields. Download bytes (`file.save`) travel next to the JSON as raw bytes
//! and the params must announce exactly them ([`crate::device::file_save_params`]).
//!
//! # Output JSON (one object per [`Output`])
//!
//! ```text
//! {"type":"sendText","text":"…"}
//! {"type":"sendFrame"}                                   + frame bytes
//! {"type":"event","id":n,"event":{…}}
//! {"type":"data","id":n,"channel":c}                     + chunk bytes
//! {"type":"settled","id":n,"outcome":{"ok":true,"result":{…},"simulated":b,"held":b,
//!     "blobs":[{"channel":c,"name"?:"…","contentType":"…"}]}}   + one byte run per blob
//! {"type":"settled","id":n,"outcome":{"ok":false,"code":"cancelled","detail"?:"…"}}
//! {"type":"closeConnection","code":1012,"reason":"…"}
//! ```
//!
//! The JS binding attaches the bytes as `Uint8Array`s (`frame`, `bytes`,
//! `blobs[i].bytes`); the WASI framing adds `offset`/`len` into a payload
//! section ([`encode_framed`]); UniFFI maps outputs onto a typed enum.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::device::{
    negotiate_explained, server_advertisement, server_consumes, BrokerConfig, DeviceBroker,
    EventRate, LocalRefusal, OpenSpec, Outcome, Output, RetainedBytesPool, RevisionOverride,
    ViolationRate, CONTROL_STREAM_INITIAL_CREDIT, CONTROL_STREAM_REOPEN_LEAD_MS,
    CONTROL_STREAM_TIMEOUT_MS, DEFAULT_MAX_RETAINED_BYTES, DEFAULT_PROCESS_RETAINED_BYTES,
    DEFAULT_STREAM_INITIAL_CREDIT, DEFAULT_TIMEOUT_MS, DEFAULT_UPLOAD_INITIAL_CREDIT,
    DEVICE_PLANE_CLOSE_CODE, DO_AGGREGATE_RETAINED_BYTES, DO_MAX_RETAINED_BYTES,
    MAX_BACKGROUND_PINNED_MODULES, MAX_QUEUED_BULK_BYTES, MIN_FRAME_CHARGE_BYTES,
    STREAM_DRAIN_TIMEOUT_MS,
};
use crate::serialize::device::{
    find_revision, limits, registry, select_device_ack, CapabilityOffer, DataPlane, DeviceAck,
    DeviceErrorCode, DeviceHello, Lifetime, Mode, DEVICE_PROTOCOL_VERSION, FRAME_HEADER_LEN,
    LEASE_EXPIRY_MS, LEASE_RENEW_INTERVAL_MS, MAX_BULK_CHUNK_BYTES, MAX_TRANSPORT_PENDING_BYTES,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigJson {
    ack: Value,
    server_capabilities: Option<Vec<CapabilityOffer>>,
    max_retained_bytes: Option<u64>,
    max_item_bytes: Option<u64>,
    max_background_owners: Option<usize>,
    min_frame_charge: Option<u64>,
    drain_timeout_ms: Option<u64>,
    event_rate: Option<EventRateJson>,
    violation_rate: Option<ViolationRateJson>,
    control_stream_timeout_ms: Option<u64>,
    control_stream_initial_credit: Option<u64>,
    scheduler: Option<SchedulerJson>,
    revision_overrides: Option<Vec<OverrideJson>>,
    request_id_limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventRateJson {
    request_burst: Option<f64>,
    request_per_second: Option<f64>,
    connection_burst: Option<f64>,
    connection_per_second: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ViolationRateJson {
    burst: Option<f64>,
    per_second: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchedulerJson {
    turn_bytes: Option<usize>,
    pending_limit: Option<usize>,
    max_queued_bytes: Option<usize>,
    retry_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OverrideJson {
    capability: String,
    version: u32,
    lifetimes: Option<Vec<Lifetime>>,
    max_item_bytes: Option<u64>,
    max_items: Option<u16>,
    max_initial_credit: Option<u64>,
    max_outstanding_credit: Option<u64>,
    max_timeout_ms: Option<u64>,
}

use Lifetime::{Activation as A, Background as B, Connection as C};

/// Every ordered, repetition-free lifetime list (the first entry is the
/// revision's default, so order matters). Registry revisions borrow
/// `&'static` slices; an override picks the matching one from here instead
/// of leaking memory per broker.
const LIFETIME_LISTS: &[&[Lifetime]] = &[
    &[A],
    &[B],
    &[C],
    &[A, B],
    &[A, C],
    &[B, A],
    &[B, C],
    &[C, A],
    &[C, B],
    &[A, B, C],
    &[A, C, B],
    &[B, A, C],
    &[B, C, A],
    &[C, A, B],
    &[C, B, A],
];

fn static_lifetimes(list: &[Lifetime]) -> Option<&'static [Lifetime]> {
    LIFETIME_LISTS.iter().copied().find(|l| *l == list)
}

fn finite_non_negative(v: Option<f64>, default: f64, what: &str) -> Result<f64, String> {
    match v {
        None => Ok(default),
        Some(x) if x.is_finite() && x >= 0.0 => Ok(x),
        Some(x) => Err(format!(
            "{what} must be a finite non-negative number, got {x}"
        )),
    }
}

/// A host-supplied count or time given as a JS number (`consumedEvents`,
/// `consumedData`, `setTransportBuffered`, every `now_ms`): finite and
/// non-negative, floored, saturating at `u64::MAX` (so `1e300` means "as
/// many as possible", which the broker then clamps to what it really
/// delivered). NaN, infinities and negatives are host errors.
pub fn host_number(v: f64, what: &str) -> Result<u64, String> {
    if v.is_finite() && v >= 0.0 {
        // `as` from f64 saturates at the u64 range.
        Ok(v.floor() as u64)
    } else {
        Err(format!(
            "{what} must be a finite non-negative number, got {v}"
        ))
    }
}

/// A host count as `usize`, saturating on 32-bit targets (wasm32) instead of
/// truncating: 2^32 buffered bytes must not read as 0.
pub fn saturating_usize(v: u64) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

/// Parse the broker configuration JSON (module docs) into a
/// [`BrokerConfig`], attaching `pool` as the aggregate retained-bytes
/// budget when given.
pub fn parse_config(json: &str, pool: Option<RetainedBytesPool>) -> Result<BrokerConfig, String> {
    let raw: ConfigJson =
        serde_json::from_str(json).map_err(|e| format!("invalid device broker config: {e}"))?;
    let ack = DeviceAck::from_value(&raw.ack)
        .map_err(|e| format!("invalid device broker config: ack: {e}"))?;
    let mut config = BrokerConfig::new(ack);
    if let Some(caps) = raw.server_capabilities {
        for offer in &caps {
            offer
                .validate()
                .map_err(|e| format!("invalid device broker config: serverCapabilities: {e}"))?;
        }
        config.server_capabilities = caps;
    }
    if let Some(v) = raw.max_retained_bytes {
        config.max_retained_bytes = v;
    }
    if raw.max_item_bytes.is_some() {
        config.max_item_bytes = raw.max_item_bytes;
    }
    if let Some(v) = raw.max_background_owners {
        config.max_background_owners = v;
    }
    if let Some(v) = raw.min_frame_charge {
        config.min_frame_charge = v;
    }
    if let Some(v) = raw.drain_timeout_ms {
        config.drain_timeout_ms = v;
    }
    if let Some(r) = raw.event_rate {
        let d = EventRate::default();
        config.event_rate = EventRate {
            request_burst: finite_non_negative(r.request_burst, d.request_burst, "requestBurst")?,
            request_per_second: finite_non_negative(
                r.request_per_second,
                d.request_per_second,
                "requestPerSecond",
            )?,
            connection_burst: finite_non_negative(
                r.connection_burst,
                d.connection_burst,
                "connectionBurst",
            )?,
            connection_per_second: finite_non_negative(
                r.connection_per_second,
                d.connection_per_second,
                "connectionPerSecond",
            )?,
        };
    }
    if let Some(r) = raw.violation_rate {
        let d = ViolationRate::default();
        config.violation_rate = ViolationRate {
            burst: finite_non_negative(r.burst, d.burst, "violationRate.burst")?,
            per_second: finite_non_negative(r.per_second, d.per_second, "violationRate.perSecond")?,
        };
    }
    if let Some(v) = raw.control_stream_timeout_ms {
        config.control_stream_timeout_ms = v;
    }
    if let Some(v) = raw.control_stream_initial_credit {
        config.control_stream_initial_credit = v;
    }
    if let Some(s) = raw.scheduler {
        let d = config.scheduler;
        config.scheduler.turn_bytes = s.turn_bytes.unwrap_or(d.turn_bytes);
        config.scheduler.pending_limit = s.pending_limit.unwrap_or(d.pending_limit);
        config.scheduler.max_queued_bytes = s.max_queued_bytes.unwrap_or(d.max_queued_bytes);
        config.scheduler.retry_ms = s.retry_ms.unwrap_or(d.retry_ms);
        if config.scheduler.turn_bytes == 0 {
            return Err("invalid device broker config: scheduler.turnBytes must be >= 1".into());
        }
    }
    if let Some(overrides) = raw.revision_overrides {
        for o in overrides {
            let mut revision = *find_revision(&o.capability, o.version).ok_or_else(|| {
                format!(
                    "invalid device broker config: revisionOverrides: {}@{} is not a registry revision",
                    o.capability, o.version
                )
            })?;
            if let Some(list) = o.lifetimes {
                revision.lifetimes = static_lifetimes(&list).ok_or_else(|| {
                    format!(
                        "invalid device broker config: revisionOverrides: {}@{} lifetimes must be \
                         a non-empty list without repeats",
                        o.capability, o.version
                    )
                })?;
            }
            if let Some(v) = o.max_item_bytes {
                revision.max_item_bytes = v;
            }
            if let Some(v) = o.max_items {
                revision.max_items = v;
            }
            if let Some(v) = o.max_initial_credit {
                revision.max_initial_credit = v;
            }
            if let Some(v) = o.max_outstanding_credit {
                revision.max_outstanding_credit = v;
            }
            if let Some(v) = o.max_timeout_ms {
                revision.max_timeout_ms = v;
            }
            config.revision_overrides.push(RevisionOverride {
                capability: o.capability,
                revision,
            });
        }
    }
    if let Some(v) = raw.request_id_limit {
        if v < 2 {
            return Err("invalid device broker config: requestIdLimit must be >= 2".into());
        }
        config.request_id_limit = v;
    }
    config.pool = pool;
    Ok(config)
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenJson {
    capability: String,
    version: Option<u32>,
    #[serde(default = "empty_object")]
    params: Value,
    module_instance_id: String,
    activation_id: u32,
    lifetime: Option<Lifetime>,
    timeout_ms: Option<u64>,
    initial_credit: Option<u64>,
    #[serde(default)]
    allow_zero_credit: bool,
    mode: Option<String>,
    #[serde(default)]
    hold_result: bool,
    #[serde(default)]
    replayed: bool,
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// Parse the open JSON (module docs) into an [`OpenSpec`]; `download`
/// carries `file.save` bytes. Malformed JSON is a host error (`Err`), not a
/// protocol refusal: the broker's own admission decides everything else.
pub fn parse_open_spec(json: &str, download: Option<Vec<u8>>) -> Result<OpenSpec, String> {
    let raw: OpenJson =
        serde_json::from_str(json).map_err(|e| format!("invalid device open spec: {e}"))?;
    let mode = match raw.mode.as_deref() {
        None => None,
        Some("unary") => Some(Mode::Unary),
        Some("stream") => Some(Mode::Stream),
        Some(other) => {
            return Err(format!(
                "invalid device open spec: mode must be \"unary\" or \"stream\", got {other:?}"
            ))
        }
    };
    let mut spec = OpenSpec::new(
        raw.capability,
        raw.params,
        raw.module_instance_id,
        raw.activation_id,
    );
    spec.version = raw.version;
    spec.lifetime = raw.lifetime;
    spec.timeout_ms = raw.timeout_ms;
    spec.initial_credit = raw.initial_credit;
    spec.allow_zero_credit = raw.allow_zero_credit;
    spec.mode = mode;
    spec.download = download;
    spec.hold_result = raw.hold_result;
    spec.replayed = raw.replayed;
    Ok(spec)
}

/// The wire spelling of an error code (`"invalidParams"`).
pub fn error_code_str(code: DeviceErrorCode) -> &'static str {
    match code {
        DeviceErrorCode::Unsupported => "unsupported",
        DeviceErrorCode::Unavailable => "unavailable",
        DeviceErrorCode::Denied => "denied",
        DeviceErrorCode::Revoked => "revoked",
        DeviceErrorCode::Cancelled => "cancelled",
        DeviceErrorCode::Timeout => "timeout",
        DeviceErrorCode::Throttled => "throttled",
        DeviceErrorCode::ConnectionLost => "connectionLost",
        DeviceErrorCode::InvalidParams => "invalidParams",
        DeviceErrorCode::Internal => "internal",
    }
}

/// Parse a wire error code (`"connectionLost"`), exactly.
pub fn parse_error_code(s: &str) -> Result<DeviceErrorCode, String> {
    DeviceErrorCode::ALL
        .into_iter()
        .find(|c| error_code_str(*c) == s)
        .ok_or_else(|| format!("unknown device error code {s:?}"))
}

/// `{"id": n}` for an opened request, `{"error": {"code", "detail"?}}` for a
/// local refusal (nothing was sent).
pub fn open_result_json(result: Result<u32, LocalRefusal>) -> Value {
    match result {
        Ok(id) => json!({ "id": id }),
        Err(refusal) => {
            let mut error = json!({ "code": error_code_str(refusal.code) });
            if let Some(detail) = refusal.detail {
                error["detail"] = Value::String(detail);
            }
            json!({ "error": error })
        }
    }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/// A settlement's `outcome` JSON with its blob bytes split out, in
/// `blobs` order (the JSON `blobs[i]` objects carry no bytes).
pub fn outcome_parts(outcome: Outcome) -> (Value, Vec<Vec<u8>>) {
    match outcome {
        Outcome::Ok {
            result,
            blobs,
            simulated,
            held,
        } => {
            let mut bytes = Vec::with_capacity(blobs.len());
            let described: Vec<Value> = blobs
                .into_iter()
                .map(|b| {
                    let mut o = json!({ "channel": b.channel, "contentType": b.content_type });
                    if let Some(name) = b.name {
                        o["name"] = Value::String(name);
                    }
                    bytes.push(b.bytes);
                    o
                })
                .collect();
            (
                json!({
                    "ok": true,
                    "result": result,
                    "blobs": described,
                    "simulated": simulated,
                    "held": held,
                }),
                bytes,
            )
        }
        Outcome::Err { code, detail } => {
            let mut o = json!({ "ok": false, "code": error_code_str(code) });
            if let Some(detail) = detail {
                o["detail"] = Value::String(detail);
            }
            (o, Vec::new())
        }
    }
}

/// Encode polled outputs for the WASI surface:
///
/// ```text
/// [u32 LE header_len][header: UTF-8 JSON array, header_len bytes][payload bytes]
/// ```
///
/// The header is the output JSON array (module docs). Every byte run —
/// a `sendFrame`'s frame, a `data` chunk, each settled blob — lives in the
/// payload section and is referenced by `"offset"` (from the start of the
/// payload section) and `"len"` members on the object that owns it
/// (`blobs[i]` for blobs). Text never shares the payload section, so a host
/// decodes JSON and bytes without any escaping or ambiguity.
pub fn encode_framed(outputs: Vec<Output>) -> Vec<u8> {
    let mut payload: Vec<u8> = Vec::new();
    let mut put = |bytes: &[u8]| -> (usize, usize) {
        let offset = payload.len();
        payload.extend_from_slice(bytes);
        (offset, bytes.len())
    };
    let header: Vec<Value> = outputs
        .into_iter()
        .map(|o| match o {
            Output::SendText(text) => json!({ "type": "sendText", "text": text }),
            Output::SendFrame(frame) => {
                let (offset, len) = put(&frame);
                json!({ "type": "sendFrame", "offset": offset, "len": len })
            }
            Output::Event { id, event } => json!({ "type": "event", "id": id, "event": event }),
            Output::Data { id, channel, bytes } => {
                let (offset, len) = put(&bytes);
                json!({ "type": "data", "id": id, "channel": channel, "offset": offset, "len": len })
            }
            Output::Settled { id, outcome } => {
                let (mut outcome, blobs) = outcome_parts(outcome);
                if let Some(Value::Array(described)) = outcome.get_mut("blobs") {
                    for (desc, bytes) in described.iter_mut().zip(&blobs) {
                        let (offset, len) = put(bytes);
                        desc["offset"] = json!(offset);
                        desc["len"] = json!(len);
                    }
                }
                json!({ "type": "settled", "id": id, "outcome": outcome })
            }
            Output::CloseConnection { code, reason } => {
                json!({ "type": "closeConnection", "code": code, "reason": reason })
            }
        })
        .collect();
    let header = Value::Array(header).to_string().into_bytes();
    let mut out = Vec::with_capacity(4 + header.len() + payload.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&payload);
    out
}

/// Inverse of [`encode_framed`]: the header array and the payload section.
/// The reference decoder hosts mirror (and the tests use).
pub fn decode_framed(buf: &[u8]) -> Result<(Value, &[u8]), String> {
    let len_bytes: [u8; 4] = buf
        .get(..4)
        .and_then(|b| b.try_into().ok())
        .ok_or("framed buffer shorter than its 4-byte header length")?;
    let header_len = u32::from_le_bytes(len_bytes) as usize;
    let end = 4usize
        .checked_add(header_len)
        .filter(|&e| e <= buf.len())
        .ok_or("framed header length exceeds the buffer")?;
    let header: Value =
        serde_json::from_slice(&buf[4..end]).map_err(|e| format!("framed header: {e}"))?;
    if !header.is_array() {
        return Err("framed header is not a JSON array".into());
    }
    Ok((header, &buf[end..]))
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/// A [`DeviceBroker`] owned by a binding object: the wasm-bindgen
/// `WasmDeviceBroker` (freed by `free()` or the JS `FinalizationRegistry`),
/// the UniFFI `DeviceBroker` (dropped when its last Kotlin/Swift/Python
/// reference is released) and a WASI `hypen_device_*` handle (dropped by
/// `hypen_device_broker_destroy`).
///
/// Dropping it closes the broker with `connectionLost` first, exactly as
/// `close("connectionLost")` would: live requests settle locally, draining
/// streams are abandoned, held results are released and every byte reserved
/// against the connection budget AND the shared [`RetainedBytesPool`] is
/// handed back. A binding object reclaimed by the garbage collector, or a
/// socket error path that never reached `close()`, therefore cannot keep
/// part of the process-wide (or Durable Object) aggregate budget reserved
/// forever and starve other connections into `throttled`. The close is a
/// no-op when the host already closed the broker.
pub struct OwnedBroker(DeviceBroker);

impl OwnedBroker {
    pub fn new(config: BrokerConfig, now_ms: u64) -> Self {
        OwnedBroker(DeviceBroker::new(config, now_ms))
    }
}

impl std::ops::Deref for OwnedBroker {
    type Target = DeviceBroker;
    fn deref(&self) -> &DeviceBroker {
        &self.0
    }
}

impl std::ops::DerefMut for OwnedBroker {
    fn deref_mut(&mut self) -> &mut DeviceBroker {
        &mut self.0
    }
}

impl Drop for OwnedBroker {
    fn drop(&mut self) {
        self.0.close(DeviceErrorCode::ConnectionLost);
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// A snapshot of the broker's queryable state.
pub fn info_json(b: &DeviceBroker) -> Value {
    let selection: Vec<Value> = b
        .selection()
        .iter()
        .map(|(name, version)| json!({ "name": name, "version": version }))
        .collect();
    let mut owners: Vec<String> = b.background_owners().into_iter().collect();
    owners.sort();
    json!({
        "closed": b.is_closed(),
        "started": b.is_started(),
        "binary": b.is_binary(),
        "liveCount": b.live_count(),
        "drainingCount": b.draining_count(),
        "coreStreamId": b.core_stream_id(),
        "nextDeadline": b.next_deadline(),
        "retainedBytes": b.retained_bytes(),
        "maxRetainedBytes": b.max_retained_bytes(),
        "connectionViolations": b.connection_violations(),
        "lastConnectionViolation": b.last_connection_violation(),
        "queuedBulkBytes": b.queued_bulk_bytes(),
        "bulkTurns": b.bulk_turns(),
        "backgroundOwners": owners,
        "selection": selection,
    })
}

/// The effective revision the broker enforces for `capability@version`
/// ([`DeviceBroker::revision`]: the registry revision, or its configured
/// override, with `maxItemBytes` capped by the broker's `maxItemBytes`), as
/// the registry's camelCase JSON; `null` when it is not a registry revision.
pub fn revision_json(b: &DeviceBroker, capability: &str, version: u32) -> Value {
    b.revision(capability, version)
        .map(|rev| serde_json::to_value(rev).unwrap_or(Value::Null))
        .unwrap_or(Value::Null)
}

/// [`server_consumes`] over a revision's JSON (the shape [`revision_json`]
/// returns): whether a broker-backed server has a consuming API for it —
/// unary, or a stream whose data plane flows client to server. Only
/// `mode` (`"unary" | "stream"`) and `data` (`"none" | "jsonEvents" |
/// "binaryUpload" | "binaryDownload"`) decide it; both are required and
/// every other member is ignored, so a `revision_json` answer feeds back
/// as-is. A missing or unknown `mode`/`data` is a host error.
pub fn server_consumes_json(revision_text: &str) -> Result<bool, String> {
    let v: Value = serde_json::from_str(revision_text)
        .map_err(|e| format!("invalid capability revision JSON: {e}"))?;
    let obj = v
        .as_object()
        .ok_or("invalid capability revision JSON: expected an object")?;
    let field = |k: &str| -> Result<&str, String> {
        obj.get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("invalid capability revision JSON: `{k}` must be a string"))
    };
    let mode = match field("mode")? {
        "unary" => Mode::Unary,
        "stream" => Mode::Stream,
        other => {
            return Err(format!(
                "invalid capability revision JSON: unknown mode `{other}`"
            ))
        }
    };
    let data = match field("data")? {
        "none" => DataPlane::None,
        "jsonEvents" => DataPlane::JsonEvents,
        "binaryUpload" => DataPlane::BinaryUpload,
        "binaryDownload" => DataPlane::BinaryDownload,
        other => {
            return Err(format!(
                "invalid capability revision JSON: unknown data plane `{other}`"
            ))
        }
    };
    // Every other member of the revision is irrelevant to the answer; start
    // from any registry revision and set the two that decide it.
    let mut rev = registry()[0].revisions[0];
    rev.mode = mode;
    rev.data = data;
    Ok(server_consumes(&rev))
}

// ---------------------------------------------------------------------------
// Handshake helpers
// ---------------------------------------------------------------------------

/// `hello.device` JSON → the broker-backed server's `sessionAck.device`
/// ([`crate::device::negotiate`]), or `null` when the hello is invalid or
/// nothing mutual was found (device access disabled, UI continues).
pub fn negotiate_json(hello_text: &str, binary_route: bool) -> Value {
    match DeviceHello::decode(hello_text) {
        Ok(hello) => crate::device::negotiate(&hello, binary_route)
            .map(|ack| serde_json::to_value(ack).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// The whole server-side handshake for a raw `hello.device` JSON text
/// ([`negotiate_explained`]): `{"ack": <sessionAck.device>}` when the device
/// plane is selected, `{"ack": null, "reason": "…"}` when it is disabled
/// (reason for the server log only). `server_capabilities_json` (a
/// `[{name, versions}]` array) replaces the default advertisement; a
/// malformed one is a host error.
pub fn handshake_json(
    hello_text: &str,
    binary_route: bool,
    server_capabilities_json: Option<&str>,
) -> Result<Value, String> {
    let server: Option<Vec<CapabilityOffer>> = server_capabilities_json
        .map(|text| {
            serde_json::from_str(text).map_err(|e| format!("invalid server capabilities: {e}"))
        })
        .transpose()?;
    Ok(
        match negotiate_explained(hello_text, binary_route, server.as_deref()) {
            Ok(ack) => json!({ "ack": ack }),
            Err(reason) => json!({ "ack": null, "reason": reason }),
        },
    )
}

/// [`select_device_ack`] with explicit server lists. `hello_text` that fails
/// strict decoding selects nothing (`null`); malformed server lists are a
/// host error.
pub fn select_ack_json(
    hello_text: &str,
    server_protocol_versions: &[u32],
    server_capabilities_json: &str,
    server_binary: bool,
) -> Result<Value, String> {
    let server: Vec<CapabilityOffer> = serde_json::from_str(server_capabilities_json)
        .map_err(|e| format!("invalid server capabilities: {e}"))?;
    let Ok(hello) = DeviceHello::decode(hello_text) else {
        return Ok(Value::Null);
    };
    Ok(
        select_device_ack(&hello, server_protocol_versions, &server, server_binary)
            .map(|ack| serde_json::to_value(ack).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    )
}

/// Strictly decode `hello.device`: `{"ok": true, "value": hello}` or
/// `{"ok": false, "error": "…"}`.
pub fn validate_hello_json(text: &str) -> Value {
    match DeviceHello::decode(text) {
        Ok(hello) => json!({ "ok": true, "value": hello }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Strictly decode `sessionAck.device` (the client side of the handshake),
/// same shape as [`validate_hello_json`].
pub fn validate_ack_json(text: &str) -> Value {
    match DeviceAck::decode(text) {
        Ok(ack) => json!({ "ok": true, "value": ack }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// What a broker-backed server advertises ([`server_advertisement`]).
pub fn server_advertisement_json() -> Value {
    serde_json::to_value(server_advertisement()).unwrap_or(Value::Null)
}

/// The protocol and broker constants a native layer needs.
pub fn constants_json() -> Value {
    json!({
        "protocolVersion": DEVICE_PROTOCOL_VERSION,
        "devicePlaneCloseCode": DEVICE_PLANE_CLOSE_CODE,
        "frameHeaderLen": FRAME_HEADER_LEN,
        "maxBulkChunkBytes": MAX_BULK_CHUNK_BYTES,
        "maxTransportPendingBytes": MAX_TRANSPORT_PENDING_BYTES,
        "maxQueuedBulkBytes": MAX_QUEUED_BULK_BYTES,
        "maxMessageBytes": limits::MESSAGE_MAX_BYTES,
        "leaseRenewIntervalMs": LEASE_RENEW_INTERVAL_MS,
        "leaseExpiryMs": LEASE_EXPIRY_MS,
        "defaultTimeoutMs": DEFAULT_TIMEOUT_MS,
        "defaultMaxRetainedBytes": DEFAULT_MAX_RETAINED_BYTES,
        "defaultProcessRetainedBytes": DEFAULT_PROCESS_RETAINED_BYTES,
        "doMaxRetainedBytes": DO_MAX_RETAINED_BYTES,
        "doAggregateRetainedBytes": DO_AGGREGATE_RETAINED_BYTES,
        "defaultUploadInitialCredit": DEFAULT_UPLOAD_INITIAL_CREDIT,
        "defaultStreamInitialCredit": DEFAULT_STREAM_INITIAL_CREDIT,
        "maxBackgroundPinnedModules": MAX_BACKGROUND_PINNED_MODULES,
        "minFrameChargeBytes": MIN_FRAME_CHARGE_BYTES,
        "streamDrainTimeoutMs": STREAM_DRAIN_TIMEOUT_MS,
        "controlStreamTimeoutMs": CONTROL_STREAM_TIMEOUT_MS,
        "controlStreamReopenLeadMs": CONTROL_STREAM_REOPEN_LEAD_MS,
        "controlStreamInitialCredit": CONTROL_STREAM_INITIAL_CREDIT,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::device::{file_save_params, sha256_hex};
    use crate::serialize::device::{registry, FrameHeader, FRAME_VERSION};

    /// An ack selecting every registry capability at revision 1 (binary).
    pub(crate) fn full_ack_json() -> Value {
        let caps: Vec<Value> = registry()
            .iter()
            .map(|c| json!({ "name": c.name, "version": 1 }))
            .collect();
        json!({ "protocolVersion": 1, "binary": true, "capabilities": caps })
    }

    pub(crate) fn frame(id: u32, channel: u16, seq: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = FrameHeader {
            version: FRAME_VERSION,
            flags: 0,
            channel,
            request_id: id,
            seq,
        }
        .encode()
        .to_vec();
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn handshake_selects_or_explains() {
        let hello = |v: Value| v.to_string();
        let ok = hello(
            json!({"protocolVersions": [1], "binary": true, "capabilities": [
            {"name": "core.capabilities", "versions": [1]},
            {"name": "gallery.pick", "versions": [1]}]}),
        );
        let r = handshake_json(&ok, true, None).unwrap();
        assert_eq!(r["ack"], negotiate_json(&ok, true));
        assert_eq!(r["ack"]["capabilities"][1]["name"], "gallery.pick");
        assert!(r.get("reason").is_none());
        // Non-binary transport: binary revisions are not selectable.
        let r = handshake_json(&ok, false, None).unwrap();
        assert_eq!(r["ack"]["binary"], false);
        assert_eq!(r["ack"]["capabilities"].as_array().unwrap().len(), 1);

        // Invalid hello (D7): disabled, with the decoder's reason.
        let dup = r#"{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]},{"name":"core.capabilities","versions":[1]}]}"#;
        let r = handshake_json(dup, true, None).unwrap();
        assert_eq!(r["ack"], Value::Null);
        let reason = r["reason"].as_str().unwrap();
        assert!(reason.starts_with("invalid hello.device: "), "{reason}");
        assert!(reason.contains("duplicate"), "{reason}");
        let r = handshake_json(
            r#"{"protocolVersions":[1],"protocolVersions":[1]}"#,
            true,
            None,
        )
        .unwrap();
        assert!(r["reason"]
            .as_str()
            .unwrap()
            .contains("invalid hello.device"));

        // Valid but no common protocol version / no core.capabilities@1.
        let v2 = hello(json!({"protocolVersions": [2], "binary": true,
            "capabilities": [{"name": "core.capabilities", "versions": [1]}]}));
        let r = handshake_json(&v2, true, None).unwrap();
        assert!(
            r["reason"].as_str().unwrap().contains("protocol version"),
            "{r}"
        );
        let no_core = hello(json!({"protocolVersions": [1], "binary": true,
            "capabilities": [{"name": "gallery.pick", "versions": [1]}]}));
        let r = handshake_json(&no_core, true, None).unwrap();
        assert!(
            r["reason"]
                .as_str()
                .unwrap()
                .contains("core.capabilities@1"),
            "{r}"
        );

        // Explicit server list (first entry wins), and a malformed one.
        let r = handshake_json(
            &ok,
            true,
            Some(r#"[{"name":"core.capabilities","versions":[1]}]"#),
        )
        .unwrap();
        assert_eq!(r["ack"]["capabilities"].as_array().unwrap().len(), 1);
        assert!(handshake_json(&ok, true, Some("nope")).is_err());
    }

    #[test]
    fn host_numbers_saturate_and_reject_non_finite() {
        assert_eq!(host_number(0.0, "n"), Ok(0));
        assert_eq!(host_number(10.9, "n"), Ok(10));
        assert_eq!(host_number(1e300, "n"), Ok(u64::MAX));
        assert_eq!(host_number(f64::MAX, "n"), Ok(u64::MAX));
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, -0.5] {
            let e = host_number(bad, "event count").unwrap_err();
            assert!(e.starts_with("event count must be"), "{e}");
        }
        assert_eq!(saturating_usize(7), 7);
        assert_eq!(saturating_usize(u64::MAX), usize::MAX);
    }

    /// The JS surface's sequence (`consumedEvents(id, 1e300)` → host_number →
    /// the broker) earns credit only for events the broker delivered.
    #[test]
    fn js_style_huge_counts_are_clamped_by_the_broker() {
        let cfg = parse_config(&json!({ "ack": full_ack_json() }).to_string(), None).unwrap();
        let mut b = OwnedBroker::new(cfg, 0);
        b.start(0).unwrap();
        assert!(b.owner_activated("m1", 1, 0));
        let spec = parse_open_spec(
            &json!({"capability": "bluetooth.scan", "moduleInstanceId": "m1",
                    "activationId": 1, "initialCredit": 2})
            .to_string(),
            None,
        )
        .unwrap();
        let id = b.open(spec, 0).unwrap();
        b.poll();
        b.consumed_events(id, host_number(1e300, "n").unwrap(), 0);
        b.consumed_data(id, saturating_usize(host_number(1e300, "n").unwrap()), 0);
        assert!(b.poll().is_empty(), "no deliveries, no grant");
        assert_eq!(b.outstanding_event_credit(id), Some(2));
        b.set_transport_buffered(saturating_usize(host_number(1e300, "n").unwrap()));
        assert!(b.poll().is_empty());
    }

    #[test]
    fn config_defaults_follow_broker_config_new() {
        let cfg = parse_config(&json!({ "ack": full_ack_json() }).to_string(), None).unwrap();
        assert_eq!(cfg.max_retained_bytes, DEFAULT_MAX_RETAINED_BYTES);
        assert_eq!(cfg.max_item_bytes, None);
        assert_eq!(cfg.server_capabilities, server_advertisement());
        assert_eq!(cfg.request_id_limit, u32::MAX);
        assert!(cfg.pool.is_none());
        assert!(cfg.revision_overrides.is_empty());
    }

    #[test]
    fn config_overrides_every_member() {
        let pool = RetainedBytesPool::new(1000);
        let cfg = parse_config(
            &json!({
                "ack": full_ack_json(),
                "serverCapabilities": [{"name": "core.capabilities", "versions": [1]}],
                "maxRetainedBytes": 5, "maxItemBytes": 6, "maxBackgroundOwners": 7,
                "minFrameCharge": 8, "drainTimeoutMs": 9,
                "eventRate": {"requestBurst": 1.5, "connectionPerSecond": 2},
                "violationRate": {"burst": 3},
                "controlStreamTimeoutMs": 10, "controlStreamInitialCredit": 11,
                "scheduler": {"turnBytes": 12, "retryMs": 13},
                "revisionOverrides": [{"capability": "bluetooth.scan", "version": 1,
                    "lifetimes": ["activation", "background"], "maxTimeoutMs": 14}],
                "requestIdLimit": 15
            })
            .to_string(),
            Some(pool.clone()),
        )
        .unwrap();
        assert_eq!(cfg.server_capabilities.len(), 1);
        assert_eq!(cfg.max_retained_bytes, 5);
        assert_eq!(cfg.max_item_bytes, Some(6));
        assert_eq!(cfg.max_background_owners, 7);
        assert_eq!(cfg.min_frame_charge, 8);
        assert_eq!(cfg.drain_timeout_ms, 9);
        assert_eq!(cfg.event_rate.request_burst, 1.5);
        assert_eq!(cfg.event_rate.connection_per_second, 2.0);
        assert_eq!(
            cfg.event_rate.request_per_second,
            EventRate::default().request_per_second
        );
        assert_eq!(cfg.violation_rate.burst, 3.0);
        assert_eq!(cfg.control_stream_timeout_ms, 10);
        assert_eq!(cfg.control_stream_initial_credit, 11);
        assert_eq!(cfg.scheduler.turn_bytes, 12);
        assert_eq!(cfg.scheduler.retry_ms, 13);
        assert_eq!(cfg.scheduler.pending_limit, MAX_TRANSPORT_PENDING_BYTES);
        let o = &cfg.revision_overrides[0];
        assert_eq!(o.capability, "bluetooth.scan");
        assert_eq!(
            o.revision.lifetimes,
            &[Lifetime::Activation, Lifetime::Background]
        );
        assert_eq!(o.revision.max_timeout_ms, 14);
        let shipped = find_revision("bluetooth.scan", 1).unwrap();
        assert_eq!(o.revision.max_initial_credit, shipped.max_initial_credit);
        assert_eq!(cfg.request_id_limit, 15);
        assert!(cfg.pool.is_some());
    }

    #[test]
    fn config_rejects_unknown_members_and_bad_values() {
        let bad = [
            json!({}),
            json!({ "ack": full_ack_json(), "maxRetainedByte": 1 }),
            json!({ "ack": {"protocolVersion": 0, "binary": true, "capabilities": []} }),
            json!({ "ack": {"protocolVersion": 1, "binary": true, "capabilities": [
                {"name": "a", "version": 1}, {"name": "a", "version": 1}]} }),
            json!({ "ack": full_ack_json(), "eventRate": {"requestBurst": -1} }),
            json!({ "ack": full_ack_json(), "scheduler": {"turnBytes": 0} }),
            json!({ "ack": full_ack_json(), "requestIdLimit": 1 }),
            json!({ "ack": full_ack_json(), "serverCapabilities": [{"name": "", "versions": [1]}] }),
            json!({ "ack": full_ack_json(), "revisionOverrides": [{"capability": "nope", "version": 1}] }),
            json!({ "ack": full_ack_json(), "revisionOverrides": [{"capability": "bluetooth.scan",
                "version": 1, "lifetimes": ["activation", "activation"]}] }),
            json!({ "ack": full_ack_json(), "revisionOverrides": [{"capability": "bluetooth.scan",
                "version": 1, "lifetimes": []}] }),
        ];
        for b in bad {
            assert!(parse_config(&b.to_string(), None).is_err(), "{b}");
        }
        assert!(parse_config("not json", None).is_err());
    }

    #[test]
    fn every_lifetime_ordering_has_a_static_list() {
        let all = [A, B, C];
        for a in all {
            assert!(static_lifetimes(&[a]).is_some());
            for b in all.into_iter().filter(|x| *x != a) {
                assert!(static_lifetimes(&[a, b]).is_some());
                for c in all.into_iter().filter(|x| *x != a && *x != b) {
                    assert_eq!(static_lifetimes(&[a, b, c]), Some(&[a, b, c][..]));
                }
            }
        }
        assert!(static_lifetimes(&[]).is_none());
        assert!(static_lifetimes(&[A, A]).is_none());
    }

    #[test]
    fn open_spec_maps_every_field() {
        let spec = parse_open_spec(
            &json!({
                "capability": "gallery.pick", "version": 1,
                "params": {"mediaTypes": ["photo"], "maxCount": 1},
                "moduleInstanceId": "m1", "activationId": 3, "lifetime": "background",
                "timeoutMs": 1000, "initialCredit": 0, "allowZeroCredit": true,
                "mode": "stream", "holdResult": true, "replayed": true
            })
            .to_string(),
            Some(vec![1, 2]),
        )
        .unwrap();
        assert_eq!(spec.capability, "gallery.pick");
        assert_eq!(spec.version, Some(1));
        assert_eq!(spec.params["maxCount"], 1);
        assert_eq!(spec.module_instance_id, "m1");
        assert_eq!(spec.activation_id, 3);
        assert_eq!(spec.lifetime, Some(Lifetime::Background));
        assert_eq!(spec.timeout_ms, Some(1000));
        assert_eq!(spec.initial_credit, Some(0));
        assert!(spec.allow_zero_credit && spec.hold_result && spec.replayed);
        assert_eq!(spec.mode, Some(Mode::Stream));
        assert_eq!(spec.download, Some(vec![1, 2]));

        let minimal = parse_open_spec(
            r#"{"capability":"permission.query","moduleInstanceId":"m","activationId":1}"#,
            None,
        )
        .unwrap();
        assert_eq!(minimal.params, json!({}));
        assert_eq!(minimal.mode, None);
        assert!(!minimal.replayed);

        for bad in [
            r#"{"moduleInstanceId":"m","activationId":1}"#,
            r#"{"capability":"x","moduleInstanceId":"m","activationId":1,"mode":"both"}"#,
            r#"{"capability":"x","moduleInstanceId":"m","activationId":1,"lifetime":"forever"}"#,
            r#"{"capability":"x","moduleInstanceId":"m","activationId":1,"extra":1}"#,
            r#"{"capability":"x","moduleInstanceId":"m","activationId":-1}"#,
        ] {
            assert!(parse_open_spec(bad, None).is_err(), "{bad}");
        }
    }

    #[test]
    fn error_codes_round_trip_with_the_wire_spelling() {
        for code in DeviceErrorCode::ALL {
            let wire = serde_json::to_value(code).unwrap();
            assert_eq!(wire, json!(error_code_str(code)));
            assert_eq!(parse_error_code(error_code_str(code)), Ok(code));
        }
        assert!(parse_error_code("InvalidParams").is_err());
    }

    #[test]
    fn open_results_are_id_or_error() {
        assert_eq!(open_result_json(Ok(7)), json!({"id": 7}));
        assert_eq!(
            open_result_json(Err(LocalRefusal {
                code: DeviceErrorCode::Unsupported,
                detail: Some("x".into())
            })),
            json!({"error": {"code": "unsupported", "detail": "x"}})
        );
        assert_eq!(
            open_result_json(Err(LocalRefusal {
                code: DeviceErrorCode::Unavailable,
                detail: None
            })),
            json!({"error": {"code": "unavailable"}})
        );
    }

    #[test]
    fn framing_round_trips_every_output_kind() {
        let outputs = vec![
            Output::SendText("{\"a\":1}".into()),
            Output::SendFrame(vec![1, 2, 3]),
            Output::Event {
                id: 4,
                event: json!({"k": "v"}),
            },
            Output::Data {
                id: 5,
                channel: 2,
                bytes: vec![9; 4],
            },
            Output::Settled {
                id: 6,
                outcome: Outcome::Ok {
                    result: json!({"items": []}),
                    blobs: vec![
                        crate::device::Blob {
                            channel: 0,
                            name: Some("a.pdf".into()),
                            content_type: "application/pdf".into(),
                            bytes: b"pdf".to_vec(),
                        },
                        crate::device::Blob {
                            channel: 1,
                            name: None,
                            content_type: "image/jpeg".into(),
                            bytes: Vec::new(),
                        },
                    ],
                    simulated: true,
                    held: false,
                },
            },
            Output::Settled {
                id: 7,
                outcome: Outcome::Err {
                    code: DeviceErrorCode::InvalidParams,
                    detail: Some("bad".into()),
                },
            },
            Output::CloseConnection {
                code: 1012,
                reason: "r".into(),
            },
        ];
        let buf = encode_framed(outputs);
        let (header, payload) = decode_framed(&buf).unwrap();
        let slice = |o: &Value| {
            let off = o["offset"].as_u64().unwrap() as usize;
            let len = o["len"].as_u64().unwrap() as usize;
            payload[off..off + len].to_vec()
        };
        let h = header.as_array().unwrap();
        assert_eq!(h.len(), 7);
        assert_eq!(h[0], json!({"type": "sendText", "text": "{\"a\":1}"}));
        assert_eq!(h[1]["type"], "sendFrame");
        assert_eq!(slice(&h[1]), vec![1, 2, 3]);
        assert_eq!(h[2], json!({"type": "event", "id": 4, "event": {"k": "v"}}));
        assert_eq!(h[3]["channel"], 2);
        assert_eq!(slice(&h[3]), vec![9; 4]);
        let ok = &h[4]["outcome"];
        assert_eq!(h[4]["id"], 6);
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["simulated"], true);
        assert_eq!(ok["held"], false);
        assert_eq!(ok["blobs"][0]["name"], "a.pdf");
        assert_eq!(ok["blobs"][0]["contentType"], "application/pdf");
        assert_eq!(slice(&ok["blobs"][0]), b"pdf".to_vec());
        assert!(ok["blobs"][1].get("name").is_none());
        assert_eq!(slice(&ok["blobs"][1]), Vec::<u8>::new());
        assert_eq!(
            h[5]["outcome"],
            json!({"ok": false, "code": "invalidParams", "detail": "bad"})
        );
        assert_eq!(
            h[6],
            json!({"type": "closeConnection", "code": 1012, "reason": "r"})
        );
        assert_eq!(payload.len(), 3 + 4 + 3);
    }

    #[test]
    fn empty_poll_frames_to_an_empty_array() {
        let buf = encode_framed(Vec::new());
        assert_eq!(&buf[..4], &2u32.to_le_bytes());
        let (header, payload) = decode_framed(&buf).unwrap();
        assert_eq!(header, json!([]));
        assert!(payload.is_empty());
    }

    #[test]
    fn decode_framed_rejects_truncated_buffers() {
        assert!(decode_framed(&[1, 0]).is_err());
        assert!(decode_framed(&[9, 0, 0, 0, b'[', b']']).is_err());
        assert!(decode_framed(&[2, 0, 0, 0, b'{', b'}']).is_err());
    }

    #[test]
    fn handshake_helpers_validate_before_selecting() {
        let hello = json!({
            "protocolVersions": [1], "binary": true,
            "capabilities": [{"name": "core.capabilities", "versions": [1]},
                             {"name": "gallery.pick", "versions": [1]}]
        })
        .to_string();
        let ack = negotiate_json(&hello, true);
        assert_eq!(ack["protocolVersion"], 1);
        assert_eq!(ack["binary"], true);
        let names: Vec<&str> = ack["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["core.capabilities", "gallery.pick"]);
        // A JSON-only route drops the binary-upload revision.
        let json_only = negotiate_json(&hello, false);
        assert_eq!(json_only["binary"], false);
        assert_eq!(json_only["capabilities"].as_array().unwrap().len(), 1);
        // Invalid hello (duplicate name, D7) → device disabled.
        let dup = json!({
            "protocolVersions": [1], "binary": true,
            "capabilities": [{"name": "core.capabilities", "versions": [1]},
                             {"name": "core.capabilities", "versions": [1]}]
        })
        .to_string();
        assert_eq!(negotiate_json(&dup, true), Value::Null);
        assert_eq!(negotiate_json("{", true), Value::Null);
        assert_eq!(validate_hello_json(&dup)["ok"], false);
        assert_eq!(validate_hello_json(&hello)["ok"], true);
        assert_eq!(
            validate_hello_json(&hello)["value"]["capabilities"][1]["name"],
            "gallery.pick"
        );

        let server = json!([{"name": "core.capabilities", "versions": [1]}]).to_string();
        let sel = select_ack_json(&hello, &[1], &server, true).unwrap();
        assert_eq!(
            sel["capabilities"],
            json!([{"name": "core.capabilities", "version": 1}])
        );
        assert_eq!(
            select_ack_json(&hello, &[2], &server, true).unwrap(),
            Value::Null
        );
        assert_eq!(
            select_ack_json(&dup, &[1], &server, true).unwrap(),
            Value::Null
        );
        assert!(select_ack_json(&hello, &[1], "{", true).is_err());

        let ack_text = sel.to_string();
        assert_eq!(validate_ack_json(&ack_text)["ok"], true);
        assert_eq!(
            validate_ack_json(r#"{"protocolVersion":1,"binary":true,"capabilities":[],"x":1}"#)
                ["ok"],
            false
        );
    }

    #[test]
    fn advertisement_and_constants_are_exposed() {
        let adv = server_advertisement_json();
        assert_eq!(adv[0]["name"], "core.capabilities");
        let c = constants_json();
        assert_eq!(c["devicePlaneCloseCode"], 1012);
        assert_eq!(c["frameHeaderLen"], 12);
        assert_eq!(c["maxMessageBytes"], 1_048_576);
    }

    #[test]
    fn revision_json_reports_the_effective_revision() {
        let cfg = parse_config(
            &json!({ "ack": full_ack_json(), "maxItemBytes": 1024,
                     "revisionOverrides": [{"capability": "bluetooth.scan", "version": 1,
                        "lifetimes": ["activation", "background"], "maxTimeoutMs": 99}] })
            .to_string(),
            None,
        )
        .unwrap();
        let b = DeviceBroker::new(cfg, 0);
        let pick = revision_json(&b, "gallery.pick", 1);
        let shipped = find_revision("gallery.pick", 1).unwrap();
        assert_eq!(pick["version"], 1);
        assert_eq!(pick["mode"], "unary");
        assert_eq!(pick["data"], "binaryUpload");
        assert_eq!(pick["consent"], "perUse");
        assert_eq!(pick["lifetimes"], json!(["activation"]));
        // The broker-wide maxItemBytes caps the registry's 64 MiB.
        assert_eq!(pick["maxItemBytes"], 1024);
        assert_eq!(pick["maxItems"], shipped.max_items);
        assert_eq!(pick["maxTimeoutMs"], shipped.max_timeout_ms);
        let scan = revision_json(&b, "bluetooth.scan", 1);
        assert_eq!(scan["lifetimes"], json!(["activation", "background"]));
        assert_eq!(scan["maxTimeoutMs"], 99);
        assert_eq!(scan["overflow"], "dropOldest");
        assert_eq!(revision_json(&b, "gallery.pick", 2), Value::Null);
        assert_eq!(revision_json(&b, "nope", 1), Value::Null);
    }

    #[test]
    fn server_consumes_follows_mode_and_data_plane() {
        let cfg = parse_config(&json!({ "ack": full_ack_json() }).to_string(), None).unwrap();
        let b = DeviceBroker::new(cfg, 0);
        // Every registry revision is consumed, and a revision() answer feeds
        // straight back.
        for decl in registry() {
            for rev in decl.revisions {
                let text = revision_json(&b, decl.name, rev.version).to_string();
                assert_eq!(server_consumes_json(&text), Ok(server_consumes(rev)));
                assert_eq!(server_consumes_json(&text), Ok(true), "{}", decl.name);
            }
        }
        let cases = [
            ("unary", "none", true),
            ("unary", "binaryDownload", true),
            ("stream", "jsonEvents", true),
            ("stream", "binaryUpload", true),
            ("stream", "none", false),
            ("stream", "binaryDownload", false),
        ];
        for (mode, data, want) in cases {
            let text = json!({ "mode": mode, "data": data }).to_string();
            assert_eq!(server_consumes_json(&text), Ok(want), "{mode}/{data}");
        }
        for bad in [
            "{",
            "[]",
            r#"{"data": "none"}"#,
            r#"{"mode": "unary"}"#,
            r#"{"mode": "sometimes", "data": "none"}"#,
            r#"{"mode": "unary", "data": "sideways"}"#,
            r#"{"mode": 1, "data": "none"}"#,
        ] {
            assert!(server_consumes_json(bad).is_err(), "{bad}");
        }
    }

    /// One upload (gallery.pick) and one download (file.save) end to end
    /// through a broker configured by JSON, with outputs through the WASI
    /// framing: the shapes every binding surface shares.
    #[test]
    fn upload_and_download_through_the_json_surface() {
        let cfg = parse_config(&json!({ "ack": full_ack_json() }).to_string(), None).unwrap();
        let mut b = DeviceBroker::new(cfg, 0);
        let core = b.start(0).unwrap();
        assert!(b.owner_activated("m1", 1, 0));
        let spec = parse_open_spec(
            &json!({"capability": "gallery.pick", "params": {"mediaTypes": ["photo"], "maxCount": 1},
                    "moduleInstanceId": "m1", "activationId": 1})
            .to_string(),
            None,
        )
        .unwrap();
        let id = open_result_json(b.open(spec, 1))["id"].as_u64().unwrap() as u32;
        assert_ne!(id, core);
        let (header, _) = decode_framed(&encode_framed(b.poll())).unwrap();
        let texts: Vec<Value> = header
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["type"] == "sendText")
            .map(|o| serde_json::from_str(o["text"].as_str().unwrap()).unwrap())
            .collect();
        assert!(texts
            .iter()
            .any(|t| t["type"] == "deviceRequest" && t["capability"] == "gallery.pick"));

        let photo = b"\xff\xd8jpeg-bytes".to_vec();
        let start = json!({"type": "deviceEvent", "id": id, "event":
            {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": photo.len()}});
        assert!(b.on_text(&start.to_string(), 2));
        assert!(b.on_frame(&frame(id, 0, 0, &photo), 3));
        let result = json!({"type": "deviceResponse", "id": id, "result": {"items": [{
            "channel": 0, "contentType": "image/jpeg", "bytes": photo.len(),
            "sha256": sha256_hex(&photo)}]}});
        assert!(b.on_text(&result.to_string(), 4));
        let buf = encode_framed(b.poll());
        let (header, payload) = decode_framed(&buf).unwrap();
        let settled = header
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["type"] == "settled" && o["id"] == id)
            .expect("upload settled");
        let blob = &settled["outcome"]["blobs"][0];
        assert_eq!(settled["outcome"]["ok"], true);
        let (off, len) = (
            blob["offset"].as_u64().unwrap() as usize,
            blob["len"].as_u64().unwrap() as usize,
        );
        assert_eq!(&payload[off..off + len], &photo[..]);

        // Download: announce, grant, frames, receipt.
        let data = b"hello, file".to_vec();
        let spec = parse_open_spec(
            &json!({"capability": "file.save",
                    "params": file_save_params("a.txt", "text/plain", &data),
                    "moduleInstanceId": "m1", "activationId": 1})
            .to_string(),
            Some(data.clone()),
        )
        .unwrap();
        let dl = open_result_json(b.open(spec, 5))["id"].as_u64().unwrap() as u32;
        b.poll();
        let grant = json!({"type": "deviceEvent", "id": dl, "control": {"grant": 65536}});
        assert!(b.on_text(&grant.to_string(), 6));
        let mut sent = Vec::new();
        for _ in 0..8 {
            let buf = encode_framed(b.poll());
            let (header, payload) = decode_framed(&buf).unwrap();
            for o in header.as_array().unwrap() {
                if o["type"] == "sendFrame" {
                    let off = o["offset"].as_u64().unwrap() as usize;
                    let len = o["len"].as_u64().unwrap() as usize;
                    sent.extend_from_slice(&payload[off + FRAME_HEADER_LEN..off + len]);
                }
            }
        }
        assert_eq!(sent, data);
        let receipt =
            json!({"type": "deviceResponse", "id": dl, "result": {"bytesWritten": data.len()}});
        assert!(b.on_text(&receipt.to_string(), 7));
        let (header, _) = decode_framed(&encode_framed(b.poll())).unwrap();
        let settled = header
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["type"] == "settled" && o["id"] == dl)
            .expect("download settled");
        assert_eq!(settled["outcome"]["ok"], true);
        assert_eq!(settled["outcome"]["result"]["bytesWritten"], data.len());

        let info = info_json(&b);
        assert_eq!(info["started"], true);
        assert_eq!(info["coreStreamId"], core);
        assert_eq!(info["liveCount"], 1, "only core.capabilities is live");
        assert_eq!(info["retainedBytes"], 0);
    }

    /// A started [`OwnedBroker`] sharing `pool`, with `m1` active as 1.
    fn owned(pool: &RetainedBytesPool) -> OwnedBroker {
        let cfg = parse_config(
            &json!({ "ack": full_ack_json() }).to_string(),
            Some(pool.clone()),
        )
        .unwrap();
        let mut b = OwnedBroker::new(cfg, 0);
        b.start(0).unwrap();
        assert!(b.owner_activated("m1", 1, 0));
        b.poll();
        b
    }

    fn open_id(b: &mut OwnedBroker, spec: Value, download: Option<Vec<u8>>) -> u32 {
        let spec = parse_open_spec(&spec.to_string(), download).unwrap();
        let id = b.open(spec, 1).expect("opens");
        b.poll();
        id
    }

    fn feed(b: &mut OwnedBroker, v: Value) {
        assert!(b.on_text(&v.to_string(), 2), "{v}");
    }

    /// A broker that holds every kind of retained-bytes reservation: a live
    /// upload mid-transfer, a held (settled, unreleased) result, a streamed
    /// upload draining with unconsumed chunks, and an announced download.
    fn holding_everything(pool: &RetainedBytesPool) -> OwnedBroker {
        let before = pool.in_use();
        let mut b = owned(pool);
        let gallery = json!({"capability": "gallery.pick",
            "params": {"mediaTypes": ["photo"], "maxCount": 1},
            "moduleInstanceId": "m1", "activationId": 1});

        // Live upload: declared 50000 bytes, 2000 received.
        let live = open_id(&mut b, gallery.clone(), None);
        feed(
            &mut b,
            json!({"type": "deviceEvent", "id": live, "event": {"kind": "blobStart",
            "channel": 0, "contentType": "image/jpeg", "bytes": 50000}}),
        );
        assert!(b.on_frame(&frame(live, 0, 0, &[7u8; 2000]), 2));

        // Held result: a complete upload whose charge waits for release_result.
        let mut spec = gallery.clone();
        spec["holdResult"] = json!(true);
        let held = open_id(&mut b, spec, None);
        let photo = vec![9u8; 3000];
        feed(
            &mut b,
            json!({"type": "deviceEvent", "id": held, "event": {"kind": "blobStart",
            "channel": 0, "contentType": "image/jpeg", "bytes": photo.len()}}),
        );
        assert!(b.on_frame(&frame(held, 0, 0, &photo), 2));
        feed(
            &mut b,
            json!({"type": "deviceResponse", "id": held, "result": {"items": [{
            "channel": 0, "contentType": "image/jpeg", "bytes": photo.len(),
            "sha256": sha256_hex(&photo)}]}}),
        );
        let settled = b.poll().into_iter().any(|o| {
            matches!(o, Output::Settled { id, outcome: Outcome::Ok { held: true, .. } } if id == held)
        });
        assert!(settled, "the held upload settles with its charge held");

        // Draining stream: mic.record succeeded, chunks not consumed.
        let mic = open_id(
            &mut b,
            json!({"capability": "mic.record", "params": {"sampleRate": 16000, "format": "pcm16"},
                   "moduleInstanceId": "m1", "activationId": 1, "initialCredit": 64}),
            None,
        );
        feed(
            &mut b,
            json!({"type": "deviceEvent", "id": mic, "event": {"kind": "blobStart",
            "channel": 0, "contentType": "audio/L16"}}),
        );
        let chunk = b"0123456789abcdef";
        assert!(b.on_frame(&frame(mic, 0, 0, chunk), 2));
        feed(
            &mut b,
            json!({"type": "deviceResponse", "id": mic, "result": {"durationMs": 10,
            "item": {"channel": 0, "contentType": "audio/L16", "bytes": chunk.len(),
                     "sha256": sha256_hex(chunk)}}}),
        );
        b.poll();
        assert_eq!(b.draining_count(), 1, "the stream drains");

        // Announced download awaiting its grant.
        let data = vec![5u8; 4096];
        open_id(
            &mut b,
            json!({"capability": "file.save",
                   "params": file_save_params("a.bin", "application/octet-stream", &data),
                   "moduleInstanceId": "m1", "activationId": 1}),
            Some(data),
        );

        assert!(b.retained_bytes() >= 50000 + 3000, "{}", b.retained_bytes());
        assert_eq!(pool.in_use() - before, b.retained_bytes());
        b
    }

    #[test]
    fn dropping_an_owned_broker_returns_every_pooled_byte() {
        let pool = RetainedBytesPool::new(1 << 30);
        let b = holding_everything(&pool);
        assert!(!b.is_closed());
        drop(b); // no close(): a freed JS object, a released UniFFI object
        assert_eq!(pool.in_use(), 0, "every reservation returns on drop");
    }

    #[test]
    fn drop_after_close_releases_nothing_twice() {
        let pool = RetainedBytesPool::new(1 << 30);
        // A second connection on the same pool keeps its reservation.
        let other = holding_everything(&pool);
        let others = other.retained_bytes();
        let mut b = holding_everything(&pool);
        assert_eq!(pool.in_use(), others + b.retained_bytes());
        b.close(DeviceErrorCode::ConnectionLost);
        assert_eq!(b.retained_bytes(), 0);
        assert_eq!(pool.in_use(), others);
        drop(b);
        assert_eq!(pool.in_use(), others, "drop after close is a no-op");
        drop(other);
        assert_eq!(pool.in_use(), 0);
    }

    #[test]
    fn a_dropped_broker_frees_budget_for_other_connections() {
        // A pool that fits exactly one 50000-byte declaration.
        let pool = RetainedBytesPool::new(60_000);
        let gallery = json!({"capability": "gallery.pick",
            "params": {"mediaTypes": ["photo"], "maxCount": 1},
            "moduleInstanceId": "m1", "activationId": 1});
        let declare = |b: &mut OwnedBroker| -> u32 {
            let id = open_id(b, gallery.clone(), None);
            let start = json!({"type": "deviceEvent", "id": id, "event": {"kind": "blobStart",
                "channel": 0, "contentType": "image/jpeg", "bytes": 50000}});
            b.on_text(&start.to_string(), 2);
            id
        };
        let mut first = owned(&pool);
        declare(&mut first);
        assert!(pool.in_use() >= 50000);
        let mut second = owned(&pool);
        let refused = declare(&mut second);
        let throttled = second.poll().into_iter().any(|o| {
            matches!(o, Output::Settled { id, outcome: Outcome::Err { code: DeviceErrorCode::Throttled, .. } } if id == refused)
        });
        assert!(
            throttled,
            "the pool is exhausted while the first broker lives"
        );
        drop(first); // freed without close()
        assert_eq!(pool.in_use(), 0);
        let mut third = owned(&pool);
        let id = declare(&mut third);
        assert!(third.is_live(id), "budget is available again");
        assert!(pool.in_use() >= 50000);
    }
}
