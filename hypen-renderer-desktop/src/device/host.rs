//! The desktop DeviceHost protocol core (RFC 001, client role), sans-IO.
//!
//! [`DeviceHost`] is the client half of the Device Capability Protocol: it
//! advertises what this host implements in `hello.device`, validates the
//! server's `sessionAck.device`, admits `deviceRequest`s against the live
//! selection, answers lease renewals, enforces deadlines and credit, frames
//! uploads, verifies downloads, and applies every violation rule of §2.1
//! (decisions D3/D8). It mirrors the iOS core
//! (`hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHost.swift`) and
//! the Android one rule for rule.
//!
//! It never touches a socket, a thread, a clock or a dialog. The owner feeds
//! it socket text/frames with the current monotonic time, drives
//! [`DeviceHost::tick`] at [`DeviceHost::next_deadline`], drains
//! [`DeviceHost::poll`] into the socket and the drivers, and reports driver
//! progress through the operation methods (`open_blob`, `succeed`, `fail`,
//! `grant_download`, …). `crate::device::DesktopDevice` is that owner for
//! the desktop's WebSocket worker; the tests drive it directly.
//!
//! Robustness is part of the contract: nothing a server sends can panic this
//! core. Malformed or unattributable device text and bad frame headers are
//! connection-level violations (discarded and counted; the connection is
//! closed only after [`HostOptions::max_connection_violations`]); a message
//! that names a live request but breaks its rules terminates that request
//! with `invalidParams`; everything for an unknown id is ignored.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;

use hypen_engine::device::is_oversize_device_text;
use hypen_engine::serialize::device::{
    attribute_invalid, find_revision, parse_strict_json, registry, validate_blob_start_for_request,
    validate_payload, validate_request, BlobStart, BlobStartKind, CapabilityOffer,
    CapabilityRevision, CapabilitySelection, ChannelSeq, Control, DataPlane, DeviceAck,
    DeviceError, DeviceErrorCode, DeviceEvent, DeviceHello, DeviceMessage, DeviceRequest,
    DeviceResponse, FrameError, FrameHeader, Lifetime, MessageKind, Owner, PayloadKind,
    ProgressState, CORE_CAPABILITIES, DEVICE_PROTOCOL_VERSION, FRAME_VERSION, LEASE_EXPIRY_MS,
    MAX_BULK_CHUNK_BYTES,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Close code for a device-protocol breach of the connection model (§2.2) or
/// repeated connection-level violations (§2.1): a protocol error.
pub const PROTOCOL_ERROR_CLOSE: u16 = 1002;

/// Held JSON events per stream while its event credit is exhausted
/// (`dropOldest`; `core.capabilities` coalesces to one latest snapshot).
const MAX_HELD_EVENTS: usize = 64;

/// Client-local policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostOptions {
    /// Client-side maximum for a module-owned request's deadline: the
    /// client uses `min(timeoutMs, max_timeout_ms)` from receipt (§2.1).
    /// The connection-owned `core.capabilities` stream is bounded by its
    /// revision instead, so the local clamp never tears it down.
    pub max_timeout_ms: u64,
    /// Lease expiry after receipt / the last accepted renewal (§2.7).
    pub lease_expiry_ms: u64,
    /// Connection-level violations (JSON limits, bad frame headers,
    /// unattributable device text) tolerated before the host closes the
    /// connection (decision D3: counted, fatal only when repeated).
    pub max_connection_violations: u32,
}

impl Default for HostOptions {
    fn default() -> Self {
        HostOptions {
            max_timeout_ms: 600_000,
            lease_expiry_ms: LEASE_EXPIRY_MS,
            max_connection_violations: 32,
        }
    }
}

/// A validated request the owner's driver for `capability` must run.
#[derive(Debug, Clone, PartialEq)]
pub struct StartRequest {
    pub id: u32,
    pub capability: String,
    pub version: u32,
    /// Params already validated against the selected revision.
    pub params: Value,
}

/// Everything the host asks its owner to do, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum HostOutput {
    /// Send this device JSON message as a text frame.
    SendText(String),
    /// Send this binary device frame (upload bytes).
    SendFrame(Vec<u8>),
    /// Run the driver for this admitted request.
    Start(StartRequest),
    /// Request `id` ended (terminal sent, cancelled, timed out, lease lost,
    /// violation, connection reset): stop its driver and clean up anything it
    /// holds (dialogs, temp files). Idempotent for the owner; emitted for
    /// every request that was started.
    Stop { id: u32 },
    /// Verified-in-order download bytes (`file.save`) for the destination.
    DownloadChunk { id: u32, bytes: Vec<u8> },
    /// Every declared download byte arrived and matches the declared SHA-256:
    /// commit the destination, then call [`DeviceHost::succeed`].
    DownloadComplete { id: u32 },
    /// Close the socket (the client reconnects with a full advertisement).
    Close { code: u16, reason: String },
}

/// Where an upload item's bytes come from.
pub enum BlobSource {
    /// Every byte of the item, in memory.
    Bytes(Vec<u8>),
    /// A reader yielding exactly `len` bytes (an existing file), read lazily
    /// as credit allows, so a large file never sits in memory.
    Reader {
        reader: Box<dyn Read + Send>,
        len: u64,
    },
    /// A live item: bytes arrive through [`DeviceHost::write_blob`] and the
    /// item ends with [`DeviceHost::finish_blob`] (or the driver's success).
    Stream { declared: Option<u64> },
}

impl std::fmt::Debug for BlobSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlobSource::Bytes(b) => write!(f, "Bytes({} B)", b.len()),
            BlobSource::Reader { len, .. } => write!(f, "Reader({len} B)"),
            BlobSource::Stream { declared } => write!(f, "Stream({declared:?})"),
        }
    }
}

// ---------------------------------------------------------------------------
// Per-request state
// ---------------------------------------------------------------------------

struct UpChannel {
    index: u16,
    content_type: String,
    declared: Option<u64>,
    /// Extra item fields of the terminal result (e.g. `name` for file.pick).
    extra: Map<String, Value>,
    chunks: VecDeque<Vec<u8>>,
    head: usize,
    buffered: u64,
    reader: Option<Box<dyn Read + Send>>,
    reader_remaining: u64,
    /// Bytes accepted into the item so far (buffered + read + sent).
    written: u64,
    sent: u64,
    next_seq: u64,
    finished: bool,
    completed: bool,
    hasher: Sha256,
    item: Option<Map<String, Value>>,
}

impl UpChannel {
    fn available(&self) -> u64 {
        self.buffered + self.reader_remaining
    }

    /// Cut the next `n` bytes (buffered first, then from the reader).
    fn take(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let Some(head) = self.chunks.front() else {
                break;
            };
            let want = n - out.len();
            let avail = head.len() - self.head;
            let k = want.min(avail);
            out.extend_from_slice(&head[self.head..self.head + k]);
            self.head += k;
            self.buffered -= k as u64;
            if self.head == head.len() {
                self.chunks.pop_front();
                self.head = 0;
            }
        }
        if out.len() < n {
            let want = n - out.len();
            let reader = self
                .reader
                .as_mut()
                .ok_or_else(|| "upload source exhausted".to_string())?;
            let start = out.len();
            out.resize(n, 0);
            reader
                .read_exact(&mut out[start..])
                .map_err(|e| format!("read failed: {e}"))?;
            self.reader_remaining -= want as u64;
            if self.reader_remaining == 0 {
                self.reader = None;
            }
        }
        Ok(out)
    }
}

struct Upload {
    channels: Vec<UpChannel>,
    max_channels: usize,
    /// Set once the driver succeeded: the terminal follows the last byte.
    result: Option<Map<String, Value>>,
    simulated: bool,
}

struct Download {
    declared: u64,
    sha256: String,
    received: u64,
    seq: ChannelSeq,
    credit: u64,
    server_paused: bool,
    hasher: Sha256,
    verified: bool,
}

struct Op {
    capability: String,
    version: u32,
    rev: CapabilityRevision,
    lifetime: Lifetime,
    params: Value,
    lease_seq: u32,
    lease_expires_at: u64,
    deadline_at: u64,
    /// Upload bytes (binaryUpload) or JSON events (jsonEvents) the server
    /// granted and this host has not spent yet.
    credit: u64,
    pending_events: VecDeque<Value>,
    progress: Option<ProgressState>,
    data_seen: bool,
    upload: Option<Upload>,
    download: Option<Download>,
    /// This host (the upload sender) reported `paused: true`.
    paused: bool,
    holds_prompt: bool,
}

enum Step {
    Frame(usize, usize),
    FinishItem(usize),
    Terminal,
    AwaitingCredit,
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/// The client-side device protocol state machine for one host (one
/// connection at a time; [`Self::attach`] starts a fresh connection).
pub struct DeviceHost {
    options: HostOptions,
    advertisement: DeviceHello,
    // ---- per connection ----
    attached: bool,
    ack_processed: bool,
    selected: Option<DeviceAck>,
    /// Live selection: name → revision (the accepted ack filtered by the
    /// latest snapshot the live core stream sent).
    live: BTreeMap<String, u32>,
    high_water: u32,
    core_opened: bool,
    core_id: Option<u32>,
    activations: HashMap<String, u32>,
    ops: BTreeMap<u32, Op>,
    bulk_order: VecDeque<u32>,
    connection_violations: u32,
    last_violation: Option<String>,
    prompt_holder: Option<u32>,
    out: VecDeque<HostOutput>,
    now: u64,
}

impl std::fmt::Debug for DeviceHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceHost")
            .field("selected", &self.selected)
            .field("live", &self.live)
            .field("ops", &self.ops.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl DeviceHost {
    /// A host implementing `capabilities` (plus the mandatory
    /// `core.capabilities`, which the host runs itself). Only registry
    /// revisions are advertised (§2.2 "advertise only implementable
    /// capability names and revision numbers"); unknown names are dropped.
    pub fn new(capabilities: &[&str], options: HostOptions) -> Self {
        let mut offers: Vec<CapabilityOffer> = Vec::new();
        for name in std::iter::once(CORE_CAPABILITIES).chain(capabilities.iter().copied()) {
            if offers.iter().any(|o| o.name == name) {
                continue;
            }
            let Some(decl) = registry().iter().find(|d| d.name == name) else {
                log::warn!("device: not advertising unknown capability {name:?}");
                continue;
            };
            offers.push(CapabilityOffer {
                name: name.to_string(),
                versions: decl.revisions.iter().map(|r| r.version).collect(),
            });
        }
        DeviceHost {
            options,
            advertisement: DeviceHello {
                protocol_versions: vec![DEVICE_PROTOCOL_VERSION],
                binary: true,
                capabilities: offers,
            },
            attached: false,
            ack_processed: false,
            selected: None,
            live: BTreeMap::new(),
            high_water: 0,
            core_opened: false,
            core_id: None,
            activations: HashMap::new(),
            ops: BTreeMap::new(),
            bulk_order: VecDeque::new(),
            connection_violations: 0,
            last_violation: None,
            prompt_holder: None,
            out: VecDeque::new(),
            now: 0,
        }
    }

    // ---- queries ---------------------------------------------------------

    /// The complete `hello.device` advertisement this host sends.
    pub fn advertisement(&self) -> &DeviceHello {
        &self.advertisement
    }

    /// `hello.device` as JSON.
    pub fn hello_device(&self) -> Value {
        serde_json::to_value(&self.advertisement).expect("hello.device serializes")
    }

    /// The accepted selection for the current connection.
    pub fn selected(&self) -> Option<&DeviceAck> {
        self.selected.as_ref()
    }

    /// The live selection (name → revision) requests are admitted against.
    pub fn live_selection(&self) -> &BTreeMap<String, u32> {
        &self.live
    }

    pub fn is_live(&self, id: u32) -> bool {
        self.ops.contains_key(&id)
    }

    pub fn live_count(&self) -> usize {
        self.ops.len()
    }

    /// Connection-level violations counted on this connection.
    pub fn connection_violations(&self) -> u32 {
        self.connection_violations
    }

    pub fn last_violation(&self) -> Option<&str> {
        self.last_violation.as_deref()
    }

    // ---- connection lifecycle -------------------------------------------

    /// A new socket: reset every per-connection state (ids, selection, core
    /// stream, activations, violations). Live requests of an old socket are
    /// stopped without sending anything (§2.5).
    pub fn attach(&mut self) {
        self.detach();
        self.attached = true;
    }

    /// The socket closed: stop everything, send nothing (§2.5).
    pub fn detach(&mut self) {
        let ids: Vec<u32> = self.ops.keys().copied().collect();
        self.ops.clear();
        for id in ids {
            self.out.push_back(HostOutput::Stop { id });
        }
        self.out.retain(|o| {
            !matches!(
                o,
                HostOutput::SendText(_) | HostOutput::SendFrame(_) | HostOutput::Start(_)
            )
        });
        self.attached = false;
        self.ack_processed = false;
        self.selected = None;
        self.live.clear();
        self.high_water = 0;
        self.core_opened = false;
        self.core_id = None;
        self.activations.clear();
        self.bulk_order.clear();
        self.connection_violations = 0;
        self.last_violation = None;
        self.prompt_holder = None;
    }

    /// `sessionAck.device` as raw JSON text (`None` when the ack carries no
    /// `device`). The first ack carrying `device` is the selection; an ack
    /// without it means "not selected yet", never "disabled for good" (D6);
    /// once processed the handshake is immutable for the socket (§2.2).
    pub fn on_ack(&mut self, device_raw: Option<&str>) {
        if !self.attached {
            return;
        }
        let Some(raw) = device_raw else {
            return;
        };
        if self.ack_processed {
            log::debug!("device: ignoring a later sessionAck.device on this socket");
            return;
        }
        self.ack_processed = true;
        let ack = match DeviceAck::decode(raw) {
            Ok(ack) => ack,
            Err(e) => {
                log::warn!("device: invalid sessionAck.device ({e}) — device plane disabled");
                return;
            }
        };
        let Some(accepted) = accept_selection(&ack, &self.advertisement) else {
            return;
        };
        self.live = accepted
            .capabilities
            .iter()
            .map(|c| (c.name.clone(), c.version))
            .collect();
        self.selected = Some(accepted);
    }

    // ---- socket input -----------------------------------------------------

    /// A device text message from the server (route by
    /// `hypen_engine::device::device_message_type`, or any text over the size
    /// limit whose `type` is a device type).
    pub fn on_text(&mut self, text: &str, now_ms: u64) {
        self.advance(now_ms);
        // No device traffic before selection completes (§2.2).
        if !self.attached || self.selected.is_none() {
            return;
        }
        // JSON limits first (§2.1, D4): text breaking them names no request.
        if is_oversize_device_text(text) {
            self.connection_violation("device message over the 1 MiB limit");
            return;
        }
        let value = match parse_strict_json(text) {
            Ok(v) => v,
            Err(_) => {
                self.connection_violation("device message breaks the JSON limits");
                return;
            }
        };
        match DeviceMessage::decode_value(&value) {
            Ok(DeviceMessage::DeviceRequest(req)) => self.handle_request(req),
            Ok(DeviceMessage::DeviceEvent(ev)) => self.handle_event(ev),
            Ok(DeviceMessage::DeviceResponse(resp)) => {
                // Only the client sends deviceResponse: on a live id it is a
                // known-id violation (D8); otherwise it is ignored.
                if self.ops.contains_key(&resp.id) {
                    self.violation(resp.id, "deviceResponse from the server");
                }
            }
            Err(e) => match attribute_invalid(&value) {
                Some((MessageKind::Request, id)) => {
                    // Never reused: a duplicate/older id drops (§2.1).
                    if id > self.high_water {
                        self.high_water = id;
                        self.send_error(
                            id,
                            DeviceErrorCode::InvalidParams,
                            Some(format!("malformed deviceRequest: {e}")),
                        );
                    }
                }
                Some((_, id)) => {
                    if self.ops.contains_key(&id) {
                        self.violation(id, &format!("malformed device message: {e}"));
                    }
                }
                None => self.connection_violation("device message without a device type and id"),
            },
        }
    }

    /// A binary device frame from the server.
    pub fn on_frame(&mut self, frame: &[u8], now_ms: u64) {
        self.advance(now_ms);
        if !self.attached || self.selected.is_none() {
            return;
        }
        match FrameHeader::decode(frame) {
            Err(FrameError::ShortHeader) => {} // droppable (§2.3)
            Err(FrameError::Violation) => {
                // Unknown version / nonzero flags (D3): the header is
                // untrusted, so no request is terminated.
                self.connection_violation("bad device frame header");
            }
            Ok((header, payload)) => {
                // Unknown ids drop without allocation (liveness first).
                let Some(op) = self.ops.get(&header.request_id) else {
                    return;
                };
                if op.rev.data != DataPlane::BinaryDownload {
                    self.violation(header.request_id, "frame against the data direction");
                    return;
                }
                self.receive_download_frame(header, payload);
            }
        }
    }

    /// Run every timer due at `now_ms` (deadlines, lease expiry) and return
    /// the next deadline.
    pub fn tick(&mut self, now_ms: u64) -> Option<u64> {
        self.advance(now_ms);
        let now = self.now;
        let due: Vec<(u32, DeviceErrorCode, Option<&'static str>)> = self
            .ops
            .iter()
            .filter_map(|(&id, op)| {
                if now >= op.deadline_at {
                    Some((id, DeviceErrorCode::Timeout, None))
                } else if now >= op.lease_expires_at {
                    Some((id, DeviceErrorCode::ConnectionLost, Some("lease-expired")))
                } else {
                    None
                }
            })
            .collect();
        for (id, code, detail) in due {
            self.settle(id, Some((code, detail.map(str::to_string))));
        }
        self.next_deadline()
    }

    /// The earliest time [`Self::tick`] must run, if any.
    pub fn next_deadline(&self) -> Option<u64> {
        self.ops
            .values()
            .map(|op| op.deadline_at.min(op.lease_expires_at))
            .min()
    }

    /// Drain everything the owner must do now, then run at most one bulk
    /// scheduling turn (call again while [`Self::has_ready_work`]).
    pub fn poll(&mut self) -> Vec<HostOutput> {
        self.run_turn();
        self.out.drain(..).collect()
    }

    /// Whether a bulk turn has work (a frame to cut, an item to close, a
    /// terminal to send, a pause to report).
    pub fn has_ready_work(&self) -> bool {
        self.bulk_order.iter().any(|id| {
            self.ops.get(id).is_some_and(|op| match next_step(op) {
                Some(Step::AwaitingCredit) => !op.paused,
                Some(_) => true,
                None => false,
            })
        })
    }

    fn advance(&mut self, now_ms: u64) {
        self.now = self.now.max(now_ms);
    }

    // ---- driver-facing operation API --------------------------------------

    /// Take the host's single prompt slot for `id` (§5: at most one
    /// prompt-raising operation per DeviceHost). `false` = another prompt is
    /// open: the driver answers `throttled`.
    pub fn acquire_prompt(&mut self, id: u32) -> bool {
        let Some(op) = self.ops.get_mut(&id) else {
            return false;
        };
        match self.prompt_holder {
            Some(holder) if holder != id => false,
            _ => {
                self.prompt_holder = Some(id);
                op.holds_prompt = true;
                true
            }
        }
    }

    /// The prompt for `id` closed (the user chose or dismissed).
    pub fn release_prompt(&mut self, id: u32) {
        if self.prompt_holder == Some(id) {
            self.prompt_holder = None;
        }
        if let Some(op) = self.ops.get_mut(&id) {
            op.holds_prompt = false;
        }
    }

    /// Optional progress report (§2.1): `pendingConsent` while the host's
    /// own interaction is open, `running` once admitted. Never goes back.
    pub fn progress(&mut self, id: u32, state: ProgressState) {
        let Some(op) = self.ops.get_mut(&id) else {
            return;
        };
        if state == ProgressState::PendingConsent
            && (op.progress == Some(ProgressState::Running) || op.data_seen)
        {
            return;
        }
        if op.progress == Some(state) {
            return;
        }
        op.progress = Some(state);
        let state_name = match state {
            ProgressState::PendingConsent => "pendingConsent",
            ProgressState::Running => "running",
        };
        self.send_event(id, json!({"kind": "progress", "state": state_name}));
    }

    /// Announce an upload item (`blobStart`, §2.4) and hand over its bytes.
    /// `extra` carries revision-specific item fields of the terminal result
    /// (e.g. `name` for file.pick). Returns the item's channel, or `None`
    /// when the request ended (the reason was already sent).
    pub fn open_blob(
        &mut self,
        id: u32,
        content_type: &str,
        extra: Map<String, Value>,
        source: BlobSource,
    ) -> Option<u16> {
        let op = self.ops.get(&id)?;
        if op.rev.data != DataPlane::BinaryUpload || op.upload.is_none() {
            self.settle_err(
                id,
                DeviceErrorCode::Internal,
                "blob on a capability without an upload plane",
            );
            return None;
        }
        let upload = op.upload.as_ref().expect("checked");
        if upload.result.is_some() {
            self.settle_err(
                id,
                DeviceErrorCode::Internal,
                "blob after the driver finished",
            );
            return None;
        }
        if upload.channels.len() >= upload.max_channels
            || upload.channels.len() > usize::from(u16::MAX)
        {
            self.settle_err(id, DeviceErrorCode::Throttled, "too many items");
            return None;
        }
        let (declared, bytes, reader, finished) = match source {
            BlobSource::Bytes(b) => (Some(b.len() as u64), Some(b), None, true),
            BlobSource::Reader { reader, len } => (Some(len), None, Some((reader, len)), true),
            BlobSource::Stream { declared } => (declared, None, None, false),
        };
        if declared.is_some_and(|d| d > op.rev.max_item_bytes) {
            self.settle_err(id, DeviceErrorCode::Throttled, "item exceeds size limit");
            return None;
        }
        let index = upload.channels.len() as u16;
        let start = BlobStart {
            kind: BlobStartKind::BlobStart,
            channel: index,
            content_type: content_type.to_string(),
            bytes: declared,
        };
        let start_value = serde_json::to_value(&start).expect("blobStart serializes");
        if let Err(why) =
            validate_payload(&op.capability, op.version, PayloadKind::Event, &start_value).and_then(
                |_| validate_blob_start_for_request(&op.capability, op.version, &op.params, &start),
            )
        {
            log::warn!("device: invalid blob announcement for request {id}: {why}");
            self.settle_err(id, DeviceErrorCode::Internal, "invalid blob announcement");
            return None;
        }
        let mut channel = UpChannel {
            index,
            content_type: content_type.to_string(),
            declared,
            extra,
            chunks: VecDeque::new(),
            head: 0,
            buffered: 0,
            reader: None,
            reader_remaining: 0,
            written: 0,
            sent: 0,
            next_seq: 0,
            finished,
            completed: false,
            hasher: Sha256::new(),
            item: None,
        };
        if let Some(b) = bytes {
            channel.written = b.len() as u64;
            channel.buffered = b.len() as u64;
            if !b.is_empty() {
                channel.chunks.push_back(b);
            }
        }
        if let Some((r, len)) = reader {
            channel.written = len;
            if len > 0 {
                channel.reader = Some(r);
                channel.reader_remaining = len;
            }
        }
        let op = self.ops.get_mut(&id).expect("live");
        op.data_seen = true;
        op.upload.as_mut().expect("checked").channels.push(channel);
        self.send_event(id, start_value);
        if !self.bulk_order.contains(&id) {
            self.bulk_order.push_back(id);
        }
        Some(index)
    }

    /// More bytes of a live ([`BlobSource::Stream`]) item.
    pub fn write_blob(&mut self, id: u32, channel: u16, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let Some(op) = self.ops.get_mut(&id) else {
            return;
        };
        let max = op.rev.max_item_bytes;
        let Some(ch) = op
            .upload
            .as_mut()
            .and_then(|u| u.channels.get_mut(usize::from(channel)))
        else {
            return;
        };
        if ch.finished {
            return;
        }
        let total = ch.written + bytes.len() as u64;
        // Limits are enforced as bytes arrive, never from the declaration (D5).
        if total > max {
            self.settle_err(id, DeviceErrorCode::Throttled, "item exceeds size limit");
            return;
        }
        if ch.declared.is_some_and(|d| total > d) {
            self.settle_err(
                id,
                DeviceErrorCode::Internal,
                "item exceeds its declared size",
            );
            return;
        }
        ch.written = total;
        ch.buffered += bytes.len() as u64;
        ch.chunks.push_back(bytes);
    }

    /// Upload bytes accepted from the driver that have not been framed onto
    /// the wire yet (waiting for credit or for a scheduling turn). A live
    /// capture bounds this window (RFC 001 §2.4 "Overflow `pause` is
    /// bounded"): past its limit the recording ends `throttled`.
    pub fn upload_backlog(&self, id: u32) -> u64 {
        self.ops
            .get(&id)
            .and_then(|op| op.upload.as_ref())
            .map(|u| u.channels.iter().map(|c| c.buffered).sum())
            .unwrap_or(0)
    }

    /// A live item ended.
    pub fn finish_blob(&mut self, id: u32, channel: u16) {
        let Some(ch) = self
            .ops
            .get_mut(&id)
            .and_then(|op| op.upload.as_mut())
            .and_then(|u| u.channels.get_mut(usize::from(channel)))
        else {
            return;
        };
        if ch.finished {
            return;
        }
        if ch.declared.is_some_and(|d| d != ch.written) {
            self.settle_err(
                id,
                DeviceErrorCode::Internal,
                "item ended before its declared size",
            );
            return;
        }
        ch.finished = true;
    }

    /// A JSON stream event from the driver (validated against the revision;
    /// credit-paced, held up to a bound while credit is exhausted).
    pub fn emit(&mut self, id: u32, event: Value) {
        let Some(op) = self.ops.get(&id) else {
            return;
        };
        let kind = event.get("kind").and_then(Value::as_str);
        if matches!(kind, Some("progress") | Some("blobStart")) {
            self.settle_err(
                id,
                DeviceErrorCode::Internal,
                "driver emitted a host-owned event",
            );
            return;
        }
        if let Err(why) = validate_payload(&op.capability, op.version, PayloadKind::Event, &event) {
            log::warn!("device: driver produced an invalid event for {id}: {why}");
            self.settle_err(id, DeviceErrorCode::Internal, "invalid event");
            return;
        }
        if op.rev.data != DataPlane::JsonEvents {
            self.send_event(id, event);
            return;
        }
        let cap = if op.capability == CORE_CAPABILITIES {
            1
        } else {
            MAX_HELD_EVENTS
        };
        let op = self.ops.get_mut(&id).expect("live");
        op.pending_events.push_back(event);
        while op.pending_events.len() > cap {
            op.pending_events.pop_front(); // dropOldest / coalesce
        }
        self.flush_events(id);
    }

    /// The driver succeeded. Uploads: the terminal (with the actual items,
    /// byte counts and SHA-256) follows the last byte. Downloads: only after
    /// [`HostOutput::DownloadComplete`]. Everything else: sent now.
    pub fn succeed(&mut self, id: u32, result: Map<String, Value>, simulated: bool) {
        let Some(op) = self.ops.get_mut(&id) else {
            return;
        };
        let holder = op.holds_prompt;
        if holder {
            op.holds_prompt = false;
            if self.prompt_holder == Some(id) {
                self.prompt_holder = None;
            }
        }
        let op = self.ops.get_mut(&id).expect("live");
        match op.rev.data {
            DataPlane::BinaryUpload => {
                let Some(upload) = op.upload.as_mut() else {
                    self.settle_err(id, DeviceErrorCode::Internal, "no upload state");
                    return;
                };
                let mut short = false;
                for ch in upload.channels.iter_mut().filter(|c| !c.finished) {
                    if ch.declared.is_some_and(|d| d != ch.written) {
                        short = true;
                        break;
                    }
                    ch.finished = true;
                }
                if short {
                    self.settle_err(
                        id,
                        DeviceErrorCode::Internal,
                        "item ended before its declared size",
                    );
                    return;
                }
                upload.result = Some(result);
                upload.simulated = simulated;
                if !self.bulk_order.contains(&id) {
                    self.bulk_order.push_back(id);
                }
            }
            DataPlane::BinaryDownload => {
                if !op.download.as_ref().is_some_and(|d| d.verified) {
                    self.settle_err(id, DeviceErrorCode::Internal, "download not verified");
                    return;
                }
                self.complete_with_result(id, result, simulated);
            }
            DataPlane::None | DataPlane::JsonEvents => {
                self.complete_with_result(id, result, simulated);
            }
        }
    }

    /// The driver failed / the user cancelled: terminate with `code`.
    pub fn fail(&mut self, id: u32, code: DeviceErrorCode, detail: Option<String>) {
        self.settle(id, Some((code, detail)));
    }

    /// Grant download credit (`file.save`) once consent and the destination
    /// are settled, and again as bytes reach the destination (§2.4). Returns
    /// the amount granted (bounded by the revision's outstanding maximum).
    pub fn grant_download(&mut self, id: u32, bytes: u64) -> u64 {
        let Some(op) = self.ops.get_mut(&id) else {
            return 0;
        };
        let max = op.rev.max_outstanding_credit;
        let Some(dl) = op.download.as_mut().filter(|d| !d.verified) else {
            return 0;
        };
        let room = max.saturating_sub(dl.credit);
        let amount = bytes.min(room).min(u64::from(u32::MAX));
        if amount == 0 {
            return 0;
        }
        dl.credit += amount;
        self.send_control(id, Control::Grant { grant: amount });
        amount
    }

    // ---- requests ----------------------------------------------------------

    fn handle_request(&mut self, req: DeviceRequest) {
        let id = req.id;
        // Never reused on a connection: duplicates/older ids drop (§2.1).
        if id <= self.high_water {
            return;
        }
        self.high_water = id;
        let is_core = req.capability == CORE_CAPABILITIES;
        // Connection model (§2.2): the connection-owned control stream opens
        // first, and at most one is live.
        if is_core {
            if self.core_id.is_some_and(|c| self.ops.contains_key(&c)) {
                self.close_connection("a second live core.capabilities stream");
                return;
            }
        } else if !self.core_opened {
            self.close_connection("app request before core.capabilities opened");
            return;
        }
        let Some(rev) = find_revision(&req.capability, req.version).copied() else {
            self.send_error(id, DeviceErrorCode::Unsupported, None);
            return;
        };
        let offered = self
            .advertisement
            .capabilities
            .iter()
            .any(|o| o.name == req.capability && o.versions.contains(&req.version));
        let selected = if is_core {
            req.version == 1
        } else {
            self.live.get(&req.capability) == Some(&req.version)
        };
        if !offered || !selected {
            self.send_error(id, DeviceErrorCode::Unsupported, None);
            return;
        }
        // activationId never goes backwards per module instance (§2.7).
        if let Owner::Activation {
            module_instance_id,
            activation_id,
        } = &req.owner
        {
            if self
                .activations
                .get(module_instance_id)
                .is_some_and(|seen| activation_id < seen)
            {
                self.send_error(
                    id,
                    DeviceErrorCode::InvalidParams,
                    Some("activationId went backwards".into()),
                );
                return;
            }
            self.activations
                .insert(module_instance_id.clone(), *activation_id);
        }
        if let Err(rejection) = validate_request(&req) {
            self.send_error(id, rejection.code, Some(rejection.reason.into_owned()));
            return;
        }
        let now = self.now;
        let local_max = if req.lifetime == Lifetime::Connection {
            rev.max_timeout_ms
        } else {
            self.options.max_timeout_ms
        };
        let mut op = Op {
            capability: req.capability.clone(),
            version: req.version,
            rev,
            lifetime: req.lifetime,
            params: req.params.clone(),
            lease_seq: 0,
            // The lease starts at receipt, including while awaiting consent.
            lease_expires_at: now.saturating_add(self.options.lease_expiry_ms),
            deadline_at: now.saturating_add(req.timeout_ms.min(local_max).max(1)),
            credit: if rev.data == DataPlane::BinaryDownload {
                0
            } else {
                req.initial_credit
            },
            pending_events: VecDeque::new(),
            progress: None,
            data_seen: false,
            upload: None,
            download: None,
            paused: false,
            holds_prompt: false,
        };
        match rev.data {
            DataPlane::BinaryUpload => {
                let mut limit = usize::from(rev.max_items);
                if let Some(mc) = req.params.get("maxCount").and_then(Value::as_u64) {
                    limit = limit.min(mc as usize);
                }
                op.upload = Some(Upload {
                    channels: Vec::new(),
                    max_channels: limit,
                    result: None,
                    simulated: false,
                });
            }
            DataPlane::BinaryDownload => {
                let declared = req.params.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                let sha = req
                    .params
                    .get("sha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                op.download = Some(Download {
                    declared,
                    sha256: sha,
                    received: 0,
                    seq: ChannelSeq::default(),
                    credit: 0,
                    server_paused: false,
                    hasher: Sha256::new(),
                    verified: false,
                });
            }
            DataPlane::None | DataPlane::JsonEvents => {}
        }
        self.ops.insert(id, op);
        if is_core {
            self.core_opened = true;
            self.core_id = Some(id);
            let snapshot = json!({ "capabilities": self.advertisement.capabilities });
            self.emit(id, snapshot);
        } else {
            self.out.push_back(HostOutput::Start(StartRequest {
                id,
                capability: req.capability,
                version: req.version,
                params: req.params,
            }));
        }
    }

    // ---- events / controls -------------------------------------------------

    fn handle_event(&mut self, ev: DeviceEvent) {
        let id = ev.id;
        // Unknown/stale ids are ignored whatever the message holds (D8).
        if !self.ops.contains_key(&id) {
            return;
        }
        let Some(control) = ev.control else {
            // Capability events flow client → server only.
            self.violation(id, "capability event from the server");
            return;
        };
        match control {
            Control::RenewLease { renew_lease } => self.renew(id, renew_lease),
            // The server retired the id: stop and answer `cancelled` (§2.1).
            Control::Cancel { .. } => self.settle(id, Some((DeviceErrorCode::Cancelled, None))),
            Control::Grant { grant } => self.grant(id, grant),
            Control::LeaseAck { .. } => self.violation(id, "leaseAck from the server"),
            Control::Paused { paused } => self.server_paused(id, paused),
        }
    }

    fn renew(&mut self, id: u32, seq: u32) {
        let now = self.now;
        let expiry = self.options.lease_expiry_ms;
        let op = self.ops.get_mut(&id).expect("live");
        // Check expiry before processing a queued renewal (§2.7).
        if now >= op.lease_expires_at {
            self.settle(
                id,
                Some((
                    DeviceErrorCode::ConnectionLost,
                    Some("lease-expired".into()),
                )),
            );
            return;
        }
        if op.lease_seq == 0 && seq != 1 {
            self.violation(id, "first renewal is not sequence 1");
            return;
        }
        if seq <= op.lease_seq {
            self.violation(id, "renewal sequence not increasing");
            return;
        }
        op.lease_seq = seq;
        op.lease_expires_at = now.saturating_add(expiry);
        self.send_control(id, Control::LeaseAck { lease_ack: seq });
    }

    fn grant(&mut self, id: u32, amount: u64) {
        let op = self.ops.get_mut(&id).expect("live");
        match op.rev.data {
            DataPlane::None => self.violation(id, "grant without a data plane"),
            // The client is the data receiver of a download.
            DataPlane::BinaryDownload => self.violation(id, "grant from the data sender"),
            DataPlane::JsonEvents | DataPlane::BinaryUpload => {
                let sum = op.credit.saturating_add(amount);
                if sum > op.rev.max_outstanding_credit {
                    self.violation(id, "credit overflow");
                    return;
                }
                op.credit = sum;
                if op.rev.data == DataPlane::JsonEvents {
                    self.flush_events(id);
                }
            }
        }
    }

    /// `paused` is reported by the data sender: legal from the server only on
    /// a download, and only as a transition.
    fn server_paused(&mut self, id: u32, flag: bool) {
        let op = self.ops.get_mut(&id).expect("live");
        let Some(dl) = op
            .download
            .as_mut()
            .filter(|_| op.rev.data == DataPlane::BinaryDownload)
        else {
            self.violation(id, "paused from the data receiver");
            return;
        };
        if dl.server_paused == flag {
            self.violation(id, "paused repeats the current state");
            return;
        }
        dl.server_paused = flag;
    }

    fn flush_events(&mut self, id: u32) {
        loop {
            let Some(op) = self.ops.get_mut(&id) else {
                return;
            };
            if op.credit == 0 {
                return;
            }
            let Some(event) = op.pending_events.pop_front() else {
                return;
            };
            op.credit -= 1;
            self.send_event(id, event);
        }
    }

    // ---- downloads -----------------------------------------------------------

    fn receive_download_frame(&mut self, header: FrameHeader, payload: &[u8]) {
        let id = header.request_id;
        let op = self.ops.get_mut(&id).expect("live");
        let overflow = op.rev.overflow;
        let Some(dl) = op.download.as_mut().filter(|d| !d.verified) else {
            self.violation(id, "bytes after the download completed");
            return;
        };
        let len = payload.len() as u64;
        let violation = if payload.is_empty() {
            Some("zero-length frame".to_string())
        } else if payload.len() > MAX_BULK_CHUNK_BYTES {
            Some("chunk above 64 KiB".to_string())
        } else if header.channel != 0 {
            Some("bytes on an unannounced channel".to_string())
        } else if dl.server_paused {
            Some("data while the sender reported paused".to_string())
        } else if !dl.seq.accept(overflow, header.seq) {
            Some(format!("seq {} rejected", header.seq))
        } else if len > dl.credit {
            Some("data beyond granted credit".to_string())
        } else if dl.received + len > dl.declared {
            Some("bytes beyond the declaration".to_string())
        } else {
            None
        };
        if let Some(why) = violation {
            self.violation(id, &why);
            return;
        }
        dl.credit -= len;
        dl.received += len;
        dl.hasher.update(payload);
        op.data_seen = true;
        self.out.push_back(HostOutput::DownloadChunk {
            id,
            bytes: payload.to_vec(),
        });
        let op = self.ops.get_mut(&id).expect("live");
        let dl = op.download.as_mut().expect("download");
        if dl.received != dl.declared {
            return;
        }
        let digest = hex(&std::mem::take(&mut dl.hasher).finalize());
        if digest != dl.sha256 {
            self.violation(id, "received bytes do not match the declared sha256");
            return;
        }
        dl.verified = true;
        self.out.push_back(HostOutput::DownloadComplete { id });
    }

    // ---- uploads: bulk scheduling (§2.3) ----------------------------------------

    /// One scheduling turn: close finished items, send ready terminals and
    /// pause transitions, and hand at most one ≤64 KiB frame (sized to the
    /// remaining credit) to the transport; operations share bulk capacity
    /// round-robin, per-operation order is preserved.
    fn run_turn(&mut self) {
        let mut handed_frame = false;
        let mut visits = self.bulk_order.len();
        while visits > 0 {
            visits -= 1;
            let Some(id) = self.bulk_order.pop_front() else {
                break;
            };
            if !self.ops.contains_key(&id) {
                continue;
            }
            let mut done = false;
            loop {
                let Some(op) = self.ops.get_mut(&id) else {
                    done = true;
                    break;
                };
                let Some(step) = next_step(op) else {
                    break;
                };
                match step {
                    Step::FinishItem(i) => {
                        let ch = &mut op.upload.as_mut().expect("upload").channels[i];
                        let mut item = ch.extra.clone();
                        item.insert("channel".into(), json!(ch.index));
                        item.insert("contentType".into(), json!(ch.content_type));
                        item.insert("bytes".into(), json!(ch.sent));
                        item.insert(
                            "sha256".into(),
                            json!(hex(&std::mem::take(&mut ch.hasher).finalize())),
                        );
                        ch.item = Some(item);
                        ch.completed = true;
                        ch.chunks.clear();
                    }
                    Step::Terminal => {
                        self.send_upload_terminal(id);
                        done = true;
                        break;
                    }
                    Step::AwaitingCredit => {
                        if !op.paused {
                            op.paused = true;
                            self.send_control(id, Control::Paused { paused: true });
                        }
                        break;
                    }
                    Step::Frame(i, n) => {
                        if handed_frame {
                            break;
                        }
                        let ch = &mut op.upload.as_mut().expect("upload").channels[i];
                        // A sender terminates before `seq` would wrap (§2.3).
                        if ch.next_seq > u64::from(u32::MAX) {
                            self.settle_err(id, DeviceErrorCode::Internal, "upload seq exhausted");
                            done = true;
                            break;
                        }
                        let payload = match ch.take(n) {
                            Ok(p) => p,
                            Err(why) => {
                                log::warn!("device: upload {id} source failed: {why}");
                                self.settle_err(
                                    id,
                                    DeviceErrorCode::Internal,
                                    "upload source failed",
                                );
                                done = true;
                                break;
                            }
                        };
                        let seq = ch.next_seq as u32;
                        let channel = ch.index;
                        ch.hasher.update(&payload);
                        ch.sent += payload.len() as u64;
                        ch.next_seq += 1;
                        op.credit -= payload.len() as u64;
                        op.data_seen = true;
                        if op.paused {
                            op.paused = false;
                            self.send_control(id, Control::Paused { paused: false });
                        }
                        let header = FrameHeader {
                            version: FRAME_VERSION,
                            flags: 0,
                            channel,
                            request_id: id,
                            seq,
                        };
                        let mut frame = header.encode().to_vec();
                        frame.extend_from_slice(&payload);
                        self.out.push_back(HostOutput::SendFrame(frame));
                        handed_frame = true;
                    }
                }
            }
            if !done && self.ops.contains_key(&id) {
                self.bulk_order.push_back(id);
            }
        }
    }

    fn send_upload_terminal(&mut self, id: u32) {
        let Some(op) = self.ops.get(&id) else {
            return;
        };
        let upload = op.upload.as_ref().expect("upload");
        let mut result = upload.result.clone().unwrap_or_default();
        let mut items: Vec<Value> = upload
            .channels
            .iter()
            .filter_map(|c| c.item.clone().map(Value::Object))
            .collect();
        if op.capability == "mic.record" {
            if items.len() != 1 {
                self.settle_err(id, DeviceErrorCode::Internal, "exactly one item expected");
                return;
            }
            result.insert("item".into(), items.remove(0));
        } else {
            result.insert("items".into(), Value::Array(items));
        }
        let simulated = upload.simulated;
        self.complete_with_result(id, result, simulated);
    }

    // ---- terminal paths -------------------------------------------------------------

    fn complete_with_result(&mut self, id: u32, result: Map<String, Value>, simulated: bool) {
        let Some(op) = self.ops.get(&id) else {
            return;
        };
        let result = Value::Object(result);
        if let Err(why) = validate_payload(&op.capability, op.version, PayloadKind::Result, &result)
        {
            log::warn!("device: driver produced an invalid result for {id}: {why}");
            self.settle_err(id, DeviceErrorCode::Internal, "invalid result");
            return;
        }
        self.retire(id);
        self.send(DeviceMessage::DeviceResponse(DeviceResponse {
            id,
            result: Some(result),
            error: None,
            simulated,
        }));
    }

    fn settle_err(&mut self, id: u32, code: DeviceErrorCode, detail: &str) {
        self.settle(id, Some((code, Some(detail.to_string()))));
    }

    /// A known-id violation (§2.1): terminate that request with
    /// `invalidParams`.
    fn violation(&mut self, id: u32, why: &str) {
        log::debug!("device: request {id} violation: {why}");
        self.settle(
            id,
            Some((DeviceErrorCode::InvalidParams, Some(truncate(why, 256)))),
        );
    }

    /// Retire a live request and optionally send its terminal error.
    fn settle(&mut self, id: u32, reply: Option<(DeviceErrorCode, Option<String>)>) {
        if !self.ops.contains_key(&id) {
            return;
        }
        self.retire(id);
        if let Some((code, detail)) = reply {
            self.send_error(id, code, detail);
        }
    }

    fn retire(&mut self, id: u32) {
        if self.ops.remove(&id).is_none() {
            return;
        }
        self.bulk_order.retain(|&x| x != id);
        if self.core_id == Some(id) {
            self.core_id = None;
        }
        if self.prompt_holder == Some(id) {
            self.prompt_holder = None;
        }
        self.out.push_back(HostOutput::Stop { id });
    }

    // ---- connection-level violations (D3) --------------------------------------------

    fn connection_violation(&mut self, reason: &str) {
        self.connection_violations = self.connection_violations.saturating_add(1);
        self.last_violation = Some(reason.to_string());
        let n = self.connection_violations;
        if n <= 4 || n.is_multiple_of(64) {
            log::debug!("device: connection-level violation #{n}: {reason}");
        }
        if n >= self.options.max_connection_violations {
            self.close_connection("repeated device protocol violations");
        }
    }

    /// The device connection's control plane broke (§2.2): close it.
    fn close_connection(&mut self, reason: &str) {
        log::warn!("device: closing the connection: {reason}");
        self.detach();
        self.out.push_back(HostOutput::Close {
            code: PROTOCOL_ERROR_CLOSE,
            reason: format!("device protocol violation: {reason}"),
        });
    }

    // ---- sending ------------------------------------------------------------------------

    fn send(&mut self, msg: DeviceMessage) {
        match serde_json::to_string(&msg) {
            Ok(text) => self.out.push_back(HostOutput::SendText(text)),
            Err(e) => log::error!("device: encode failed: {e}"),
        }
    }

    fn send_error(&mut self, id: u32, code: DeviceErrorCode, detail: Option<String>) {
        self.send(DeviceMessage::DeviceResponse(DeviceResponse {
            id,
            result: None,
            error: Some(DeviceError {
                code,
                platform_detail: detail.map(|d| truncate(&d, 512)),
            }),
            simulated: false,
        }));
    }

    fn send_control(&mut self, id: u32, control: Control) {
        self.send(DeviceMessage::DeviceEvent(DeviceEvent {
            id,
            event: None,
            control: Some(control),
        }));
    }

    fn send_event(&mut self, id: u32, event: Value) {
        // A snapshot the live core stream actually sends replaces the
        // advertisement: requests follow it from now on (§2.2).
        if self.core_id == Some(id) {
            if let Some(offers) = event.get("capabilities").and_then(Value::as_array) {
                self.apply_snapshot(offers);
            }
        }
        if let Some(op) = self.ops.get_mut(&id) {
            if event.get("kind").and_then(Value::as_str) != Some("progress") {
                op.data_seen = true;
            }
        }
        self.send(DeviceMessage::DeviceEvent(DeviceEvent {
            id,
            event: Some(event),
            control: None,
        }));
    }

    fn apply_snapshot(&mut self, offers: &[Value]) {
        let Some(accepted) = &self.selected else {
            return;
        };
        self.live = accepted
            .capabilities
            .iter()
            .filter(|sel| {
                offers.iter().any(|o| {
                    o.get("name").and_then(Value::as_str) == Some(sel.name.as_str())
                        && o.get("versions")
                            .and_then(Value::as_array)
                            .is_some_and(|v| {
                                v.iter().any(|x| x.as_u64() == Some(u64::from(sel.version)))
                            })
                })
            })
            .map(|sel| (sel.name.clone(), sel.version))
            .collect();
    }

    /// Publish a fresh full advertisement on the live `core.capabilities`
    /// stream (§2.2) — e.g. after a capability's hardware or dialog backend
    /// went away or came back. `offers` is narrowed to revisions this host
    /// actually advertised in its hello (a snapshot can withdraw, never
    /// invent). Once the snapshot is sent, requests follow it.
    pub fn republish(&mut self, offers: &[CapabilityOffer]) {
        let Some(core) = self.core_id.filter(|id| self.ops.contains_key(id)) else {
            return;
        };
        let narrowed: Vec<CapabilityOffer> = offers
            .iter()
            .filter_map(|o| {
                let adv = self
                    .advertisement
                    .capabilities
                    .iter()
                    .find(|a| a.name == o.name)?;
                let versions: Vec<u32> = o
                    .versions
                    .iter()
                    .copied()
                    .filter(|v| adv.versions.contains(v))
                    .collect();
                (!versions.is_empty()).then(|| CapabilityOffer {
                    name: o.name.clone(),
                    versions,
                })
            })
            .collect();
        self.emit(core, json!({ "capabilities": narrowed }));
    }

    /// Lifetime of a live request (diagnostics/tests).
    pub fn lifetime_of(&self, id: u32) -> Option<Lifetime> {
        self.ops.get(&id).map(|op| op.lifetime)
    }
}

/// The next scheduling step of an uploading request, without side effects.
fn next_step(op: &Op) -> Option<Step> {
    let upload = op.upload.as_ref()?;
    let mut waiting = false;
    for (i, ch) in upload.channels.iter().enumerate() {
        if ch.completed {
            continue;
        }
        let avail = ch.available();
        if avail > 0 {
            if op.credit == 0 {
                waiting = true;
                continue;
            }
            let n = avail.min(MAX_BULK_CHUNK_BYTES as u64).min(op.credit) as usize;
            return Some(Step::Frame(i, n));
        }
        // A finished item with nothing left ends now; a zero-byte item sends
        // no frame at all (D2).
        if ch.finished {
            return Some(Step::FinishItem(i));
        }
    }
    if waiting {
        return Some(Step::AwaitingCredit);
    }
    if upload.result.is_some() && upload.channels.iter().all(|c| c.completed) {
        return Some(Step::Terminal);
    }
    None
}

/// Validate the server's selection against this host's advertisement (§2.2):
/// a common protocol version and `core.capabilities@1` are required (else the
/// device plane stays off); an entry naming a revision this host never
/// offered, or a binary-plane revision without negotiated binary, is dropped.
pub fn accept_selection(ack: &DeviceAck, advertisement: &DeviceHello) -> Option<DeviceAck> {
    if !advertisement
        .protocol_versions
        .contains(&ack.protocol_version)
    {
        log::warn!("device: plane disabled: no common protocol version");
        return None;
    }
    let binary = ack.binary && advertisement.binary;
    let mut kept: Vec<CapabilitySelection> = Vec::new();
    for sel in &ack.capabilities {
        let offered = advertisement
            .capabilities
            .iter()
            .any(|o| o.name == sel.name && o.versions.contains(&sel.version));
        if !offered {
            log::warn!(
                "device: ignoring a selection this host never offered: {}",
                sel.name
            );
            continue;
        }
        let Some(rev) = find_revision(&sel.name, sel.version) else {
            continue;
        };
        if !binary && rev.data.is_binary() {
            continue;
        }
        kept.push(sel.clone());
    }
    if !kept
        .iter()
        .any(|s| s.name == CORE_CAPABILITIES && s.version == 1)
    {
        log::warn!("device: plane disabled: the server did not select core.capabilities@1");
        return None;
    }
    Some(DeviceAck {
        protocol_version: ack.protocol_version,
        binary,
        capabilities: kept,
    })
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

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}
