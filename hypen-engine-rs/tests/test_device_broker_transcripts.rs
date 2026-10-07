//! Every shared wire transcript (RFC 001, `engine-compatibility-tests/
//! fixtures/device/transcripts`) replayed through the real sans-IO
//! [`DeviceBroker`] in the **server** role.
//!
//! The harness plays the client: it feeds every `c2s` step into the broker
//! (`on_text` / `on_frame`) and checks the broker's outputs against the
//! `s2c` steps:
//!
//! - an `s2c` `deviceRequest` is produced by `DeviceBroker::open` (or
//!   `start` / a planned reopen for `core.capabilities`) and must be the
//!   exact message the broker emits (ids are translated, see below);
//! - an `s2c` `cancel` is produced by `cancel` / an owner sweep / the planned
//!   `core.capabilities` reopen, and must be emitted exactly once;
//! - an `s2c` frame must be the next frame the broker's scheduler hands out,
//!   byte for byte;
//! - an `s2c` `renewLease n` is reached by advancing the injected clock on
//!   the fixed 5 s cadence until the broker has sent renewal `n`;
//! - an `s2c` `grant` requires that the broker, too, has replenished that
//!   request since the previous transcript grant and that the sender is not
//!   starved (the amounts are the server's batching policy);
//! - a `c2s` violation must be detected in its category: request-level ones
//!   terminate the request `invalidParams` with exactly one `cancel` (none
//!   when the offending message is the client's own terminal), which must
//!   equal the transcript's `reaction`; connection-level ones (JSON limits,
//!   bad frame headers) are counted and touch no request; a terminal on the
//!   live `core.capabilities` stream closes the device plane;
//! - an `ignored` `c2s` step has no effect at all;
//! - an `s2c` step flagged as a violation is a message a *broken server*
//!   sends: the broker must refuse to produce it (`open` refuses, or emits a
//!   valid, clamped request instead), and it has no API to emit the others.
//!
//! Every broker output is also checked on its own: text strictly decodes
//! as a server → client message (`deviceRequest` passing `validate_request`,
//! or `cancel` / `renewLease` / `grant` controls), renewals start at 1 and
//! strictly increase per request, frames are well-formed non-empty ≤ 64 KiB
//! channel-0 download frames with contiguous `seq`.
//!
//! Timing is not observable in the transcript format (README), so:
//! transcript ids are mapped to the broker's own monotone ids; the broker's
//! `renewLease 1` right after each request is expected even where a
//! transcript omits it (acks are translated by the difference, as the TS
//! replay does); requests whose client never acknowledges a renewal in the
//! transcript are acknowledged by the harness so that clock advances do not
//! expire them.

use hypen_engine::device::{sha256_hex, BrokerConfig, DeviceBroker, OpenSpec, Outcome, Output};
use hypen_engine::serialize::device::{
    find_revision, registry, validate_request, CapabilityOffer, Control, DataPlane, DeviceAck,
    DeviceErrorCode, DeviceMessage, FrameHeader, Lifetime, Owner, CORE_CAPABILITIES,
    FRAME_HEADER_LEN, MAX_BULK_CHUNK_BYTES,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;

fn transcripts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/transcripts")
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Frame bytes: `hex`, followed by `payloadFill` when present.
fn frame_bytes(frame: &Value) -> Vec<u8> {
    let mut bytes = hex_decode(frame["hex"].as_str().expect("frame hex"));
    if let Some(fill) = frame.get("payloadFill") {
        let byte = u8::try_from(fill["byte"].as_u64().unwrap()).unwrap();
        let len = usize::try_from(fill["length"].as_u64().unwrap()).unwrap();
        bytes.resize(bytes.len() + len, byte);
    }
    bytes
}

fn with_request_id(mut frame: Vec<u8>, id: u32) -> Vec<u8> {
    frame[4..8].copy_from_slice(&id.to_le_bytes());
    frame
}

fn load_all() -> Vec<(String, Value)> {
    let mut files: Vec<_> = fs::read_dir(transcripts_dir())
        .expect("transcripts directory")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let name = p.file_stem().unwrap().to_string_lossy().to_string();
            let doc: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
            (name, doc)
        })
        .filter(|(_, doc)| doc.get("steps").is_some())
        .collect()
}

/// Default `ack`: every registry capability at its highest revision, binary.
fn default_ack() -> DeviceAck {
    let caps: Vec<Value> = registry()
        .iter()
        .map(|c| json!({"name": c.name, "version": c.revisions.last().unwrap().version}))
        .collect();
    DeviceAck::from_value(&json!({"protocolVersion": 1, "binary": true, "capabilities": caps}))
        .unwrap()
}

/// Download payloads by SHA-256, from every transcript whose server sends
/// the complete, matching bytes of a `file.save` announcement.
fn download_table(docs: &[(String, Value)]) -> HashMap<String, Vec<u8>> {
    let mut table = HashMap::new();
    for (_, doc) in docs {
        let steps = doc["steps"].as_array().unwrap();
        for (i, step) in steps.iter().enumerate() {
            let m = &step["message"];
            if step["dir"] != "s2c"
                || m["type"] != "deviceRequest"
                || m["capability"] != "file.save"
            {
                continue;
            }
            let payload = download_frames(steps, i, m["id"].as_u64().unwrap() as u32);
            let sha = m["params"]["sha256"].as_str().unwrap().to_string();
            if payload.len() as u64 == m["params"]["bytes"].as_u64().unwrap()
                && sha256_hex(&payload) == sha
            {
                table.insert(sha, payload);
            }
        }
    }
    table
}

/// The payload of every unflagged `s2c` frame for transcript id `id` after
/// step `from`.
fn download_frames(steps: &[Value], from: usize, id: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for later in &steps[from + 1..] {
        let f = &later["frame"];
        if later["dir"] == "s2c"
            && f.is_object()
            && f["header"]["requestId"] == id
            && later.get("expectViolation").is_none()
            && later.get("ignored").is_none()
        {
            out.extend_from_slice(&frame_bytes(f)[FRAME_HEADER_LEN..]);
        }
    }
    out
}

/// Transcript ids that no transcript step maps to a broker id get an id the
/// broker never allocates.
const UNMAPPED_BASE: u32 = 0x4000_0000;

#[derive(Default)]
struct StepLog {
    texts: Vec<DeviceMessage>,
    settled: Vec<(u32, Outcome)>,
    closed: Option<(u16, String)>,
}

struct Replay {
    broker: DeviceBroker,
    now: u64,
    /// Transcript id → broker id.
    map: HashMap<u32, u32>,
    /// Broker id → transcript id.
    rev: HashMap<u32, u32>,
    /// Transcript ids whose client acknowledges renewals itself.
    self_acking: HashSet<u32>,
    /// Broker renewals sent, per broker id (strictly increasing from 1).
    lease: HashMap<u32, u32>,
    /// Highest transcript renewal, per transcript id.
    transcript_lease: HashMap<u32, u32>,
    grants_since: HashMap<u32, u64>,
    cancels: HashMap<u32, usize>,
    settled: HashMap<u32, Outcome>,
    /// Frames handed out by the scheduler and not yet matched to a step.
    frames: VecDeque<(u32, Vec<u8>)>,
    frame_seq: HashMap<u32, u32>,
    /// Streamed upload bytes delivered to the "handler", per broker id.
    delivered: HashMap<u32, Vec<u8>>,
    /// Requests the broker emitted and no step has claimed yet.
    emitted_requests: VecDeque<DeviceMessage>,
    /// Broker id → data plane, for output invariants.
    planes: HashMap<u32, DataPlane>,
    /// Broker id → the owner it put on the wire.
    owners: HashMap<u32, Owner>,
    /// Transcript ids whose announcement the broker refused (a faulty
    /// transcript server: its bytes do not match its own announcement).
    refused: HashSet<u32>,
    /// Ids already cancelled by an owner sweep (their later cancel steps
    /// are checked, not re-issued).
    swept: HashSet<u32>,
    closed: bool,
    log: StepLog,
}

impl Replay {
    fn new(doc: &Value) -> Self {
        let ack = match doc.get("ack") {
            Some(v) => DeviceAck::from_value(v).expect("valid ack"),
            None => default_ack(),
        };
        let server: Vec<CapabilityOffer> = match doc.get("serverCapabilities") {
            Some(v) => serde_json::from_value(v.clone()).unwrap(),
            None => ack
                .capabilities
                .iter()
                .map(|c| CapabilityOffer {
                    name: c.name.clone(),
                    versions: vec![c.version],
                })
                .collect(),
        };
        let steps = doc["steps"].as_array().unwrap();
        let mut config = BrokerConfig::new(ack);
        config.server_capabilities = server;
        // The transcript's own control-stream settings (host configuration).
        if let Some(core) = steps.iter().find(|s| {
            s["dir"] == "s2c"
                && s["message"]["type"] == "deviceRequest"
                && s["message"]["capability"] == CORE_CAPABILITIES
        }) {
            config.control_stream_initial_credit =
                core["message"]["initialCredit"].as_u64().unwrap();
            config.control_stream_timeout_ms = core["message"]["timeoutMs"].as_u64().unwrap();
        }
        let self_acking = steps
            .iter()
            .filter(|s| s["dir"] == "c2s" && s["message"]["control"].get("leaseAck").is_some())
            .map(|s| s["message"]["id"].as_u64().unwrap() as u32)
            .collect();
        Replay {
            broker: DeviceBroker::new(config, 0),
            now: 0,
            map: HashMap::new(),
            rev: HashMap::new(),
            self_acking,
            lease: HashMap::new(),
            transcript_lease: HashMap::new(),
            grants_since: HashMap::new(),
            cancels: HashMap::new(),
            settled: HashMap::new(),
            frames: VecDeque::new(),
            frame_seq: HashMap::new(),
            delivered: HashMap::new(),
            emitted_requests: VecDeque::new(),
            planes: HashMap::new(),
            owners: HashMap::new(),
            refused: HashSet::new(),
            swept: HashSet::new(),
            closed: false,
            log: StepLog::default(),
        }
    }

    fn bid(&self, t: u32) -> u32 {
        *self.map.get(&t).unwrap_or(&(UNMAPPED_BASE + t))
    }

    fn link(&mut self, t: u32, b: u32) {
        self.map.insert(t, b);
        self.rev.insert(b, t);
    }

    /// Drain the broker until quiescent, checking every output, acting as
    /// the handler (streamed bytes are consumed at once) and as a live
    /// client for requests the transcript does not acknowledge itself.
    fn pump(&mut self, at: &str) {
        loop {
            let out = self.broker.poll();
            if out.is_empty() {
                break;
            }
            let mut acks = Vec::new();
            let mut consumed = Vec::new();
            for o in out {
                match o {
                    Output::SendText(text) => {
                        let msg = DeviceMessage::decode(&text).unwrap_or_else(|e| {
                            panic!("{at}: broker sent an invalid message {text}: {e}")
                        });
                        match &msg {
                            DeviceMessage::DeviceRequest(r) => {
                                let rev = validate_request(r).unwrap_or_else(|e| {
                                    panic!("{at}: broker sent an inadmissible request: {e:?}")
                                });
                                self.planes.insert(r.id, rev.data);
                                self.owners.insert(r.id, r.owner.clone());
                                self.emitted_requests.push_back(msg.clone());
                            }
                            DeviceMessage::DeviceEvent(ev) => {
                                let id = ev.id;
                                match ev.control.as_ref() {
                                    Some(Control::Cancel { cancel: true }) => {
                                        *self.cancels.entry(id).or_default() += 1;
                                    }
                                    Some(Control::RenewLease { renew_lease }) => {
                                        let last = self.lease.get(&id).copied().unwrap_or(0);
                                        assert_eq!(
                                            *renew_lease,
                                            last + 1,
                                            "{at}: renewals start at 1 and increase by 1"
                                        );
                                        self.lease.insert(id, *renew_lease);
                                        let acking = self
                                            .rev
                                            .get(&id)
                                            .is_some_and(|t| self.self_acking.contains(t));
                                        if !acking {
                                            acks.push((id, *renew_lease));
                                        }
                                    }
                                    Some(Control::Grant { grant }) => {
                                        let plane = self.planes.get(&id).copied();
                                        assert!(
                                            matches!(plane, Some(DataPlane::JsonEvents | DataPlane::BinaryUpload)),
                                            "{at}: grant on a request without a client → server plane"
                                        );
                                        *self.grants_since.entry(id).or_default() += grant;
                                    }
                                    other => {
                                        panic!("{at}: broker sent a client-side control {other:?}")
                                    }
                                }
                                assert!(ev.event.is_none(), "{at}: broker sent a capability event");
                            }
                            DeviceMessage::DeviceResponse(_) => {
                                panic!("{at}: broker sent a deviceResponse")
                            }
                        }
                        self.log.texts.push(msg);
                    }
                    Output::SendFrame(frame) => {
                        let (h, payload) = FrameHeader::decode(&frame).expect("well-formed frame");
                        assert_eq!(h.channel, 0, "{at}: download frames use channel 0");
                        assert!(
                            !payload.is_empty() && payload.len() <= MAX_BULK_CHUNK_BYTES,
                            "{at}: frame payload 1..=64 KiB"
                        );
                        assert_eq!(
                            self.planes.get(&h.request_id),
                            Some(&DataPlane::BinaryDownload)
                        );
                        let seq = self.frame_seq.entry(h.request_id).or_default();
                        assert_eq!(h.seq, *seq, "{at}: contiguous download seq");
                        *seq += 1;
                        self.frames.push_back((h.request_id, frame));
                    }
                    Output::Event { .. } => {
                        // A consumer that has not caught up: no replenishing
                        // grants beyond what the transcript shows.
                    }
                    Output::Data { id, bytes, .. } => {
                        self.delivered
                            .entry(id)
                            .or_default()
                            .extend_from_slice(&bytes);
                        consumed.push(id);
                    }
                    Output::Settled { id, outcome } => {
                        assert!(
                            self.settled.insert(id, outcome.clone()).is_none(),
                            "{at}: request {id} settled twice"
                        );
                        self.log.settled.push((id, outcome));
                    }
                    Output::CloseConnection { code, reason } => {
                        assert!(
                            self.log.closed.is_none() && !self.closed,
                            "{at}: closed twice"
                        );
                        self.log.closed = Some((code, reason));
                        self.closed = true;
                    }
                }
            }
            for id in consumed {
                self.broker.consumed_data(id, 1, self.now);
            }
            for (id, seq) in acks {
                if self.broker.is_live(id) {
                    let text =
                        json!({"type": "deviceEvent", "id": id, "control": {"leaseAck": seq}});
                    self.broker.on_text(&text.to_string(), self.now);
                }
            }
        }
    }

    fn take_log(&mut self) -> StepLog {
        std::mem::take(&mut self.log)
    }

    /// Register the request owner's activation as live (the host's module
    /// lifecycle). Returns false when the broker refuses the activation.
    fn activate(&mut self, owner: &Owner) -> bool {
        match owner {
            Owner::Activation {
                module_instance_id,
                activation_id,
            } => {
                self.broker
                    .owner_is_active(module_instance_id, *activation_id)
                    || self
                        .broker
                        .owner_activated(module_instance_id, *activation_id, self.now)
            }
            _ => false,
        }
    }

    fn spec(&self, m: &Value, download: Option<Vec<u8>>) -> OpenSpec {
        let (module, activation) = match serde_json::from_value::<Owner>(m["owner"].clone()) {
            Ok(Owner::Activation {
                module_instance_id,
                activation_id,
            }) => (module_instance_id, activation_id),
            Ok(Owner::Module { module_instance_id }) => (module_instance_id, 1),
            _ => ("connection".into(), 1),
        };
        let lifetime: Lifetime = serde_json::from_value(m["lifetime"].clone()).unwrap();
        OpenSpec {
            capability: m["capability"].as_str().unwrap().to_string(),
            version: Some(m["version"].as_u64().unwrap() as u32),
            params: m["params"].clone(),
            module_instance_id: module,
            activation_id: activation,
            lifetime: Some(lifetime),
            timeout_ms: Some(m["timeoutMs"].as_u64().unwrap()),
            initial_credit: Some(m["initialCredit"].as_u64().unwrap()),
            // Transcript servers may open an upload at zero credit.
            allow_zero_credit: true,
            mode: None,
            download,
            hold_result: false,
            replayed: false,
        }
    }
}

fn request_value(msg: &DeviceMessage) -> Value {
    serde_json::to_value(msg).unwrap()
}

fn is_cancel(msg: &DeviceMessage, id: u32) -> bool {
    matches!(msg, DeviceMessage::DeviceEvent(ev) if ev.id == id && matches!(ev.control, Some(Control::Cancel { .. })))
}

#[derive(Default, Debug)]
struct Counts {
    transcripts: usize,
    requests: usize,
    c2s_violations: usize,
    request_level: usize,
    connection_level: usize,
    connection_closes: usize,
    s2c_refusals: usize,
    frames_matched: usize,
    ignored: usize,
    successes: usize,
    sweeps: usize,
    reopens: usize,
    faulty_server_downloads: usize,
}

fn run(name: &str, doc: &Value, table: &HashMap<String, Vec<u8>>, counts: &mut Counts) {
    let steps = doc["steps"].as_array().unwrap();
    let mut r = Replay::new(doc);
    let mut pending_reaction: Option<(u32, usize)> = None;
    let mut ended = false;
    let flagged_c2s_violations = steps
        .iter()
        .filter(|s| s["dir"] == "c2s" && s.get("expectViolation").is_some())
        .count();
    let mut seen_c2s_violations = 0;

    for (i, step) in steps.iter().enumerate() {
        let at = format!("{name} step {i}");
        assert!(
            !ended,
            "{at}: nothing may follow a closed device connection"
        );
        let dir = step["dir"].as_str().unwrap();
        let reaction = step.get("reaction").is_some();
        let ignored = step.get("ignored").is_some();
        let category = step.get("expectViolation").and_then(Value::as_str);
        let msg = &step["message"];

        if dir == "s2c" {
            if reaction {
                let (t, before) = pending_reaction
                    .take()
                    .unwrap_or_else(|| panic!("{at}: reaction without a violation"));
                assert_eq!(msg["id"], t, "{at}: reaction id");
                assert_eq!(
                    msg["control"]["cancel"], true,
                    "{at}: the server's reaction is cancel"
                );
                let b = r.bid(t);
                assert_eq!(
                    r.cancels.get(&b).copied().unwrap_or(0),
                    before + 1,
                    "{at}: exactly one cancel"
                );
                if r.closed {
                    ended = true; // a violated core stream takes the plane down
                }
                continue;
            }
            if ignored {
                continue;
            }
            if let Some(cat) = category {
                // A broken server's message: the broker never produces it.
                if msg["type"] == "deviceRequest" {
                    counts.s2c_refusals += 1;
                    let t = msg["id"].as_u64().unwrap() as u32;
                    if msg["capability"] == CORE_CAPABILITIES {
                        if r.broker.is_started() {
                            assert!(r.broker.start(r.now).is_err(), "{at}: a second core stream");
                        }
                        let spec = r.spec(msg, None);
                        r.activate(&Owner::Activation {
                            module_instance_id: spec.module_instance_id.clone(),
                            activation_id: spec.activation_id,
                        });
                        assert!(
                            r.broker.open(spec, r.now).is_err(),
                            "{at}: app code opened core.capabilities"
                        );
                    } else {
                        let owner: Owner = serde_json::from_value(msg["owner"].clone())
                            .unwrap_or(Owner::Connection { connection: true });
                        r.activate(&owner);
                        let spec = r.spec(msg, None);
                        match r.broker.open(spec, r.now) {
                            Err(refusal) => {
                                if cat == "unsupported" {
                                    assert!(
                                        matches!(
                                            refusal.code,
                                            DeviceErrorCode::Unsupported
                                                | DeviceErrorCode::Unavailable
                                        ),
                                        "{at}: {refusal}"
                                    );
                                }
                            }
                            Ok(b) => {
                                // Clamped into a valid request: never the
                                // violating one.
                                r.pump(&at);
                                let emitted =
                                    r.emitted_requests.pop_back().expect("emitted request");
                                assert!(r.emitted_requests.is_empty());
                                let mut want = msg.clone();
                                want["id"] = json!(b);
                                assert_ne!(
                                    request_value(&emitted),
                                    want,
                                    "{at}: broker emitted the violating request"
                                );
                                r.broker.cancel(b, r.now);
                                r.pump(&at);
                                assert!(
                                    !r.map.contains_key(&t),
                                    "{at}: a refused transcript id is never live"
                                );
                            }
                        }
                    }
                    r.pump(&at);
                    assert!(
                        r.emitted_requests.is_empty(),
                        "{at}: refused request was sent"
                    );
                }
                continue;
            }
            if let Some(frame) = step.get("frame") {
                let t = frame["header"]["requestId"].as_u64().unwrap() as u32;
                if r.refused.contains(&t) {
                    continue;
                }
                let b = r.bid(t);
                r.pump(&at);
                let (id, got) = r
                    .frames
                    .pop_front()
                    .unwrap_or_else(|| panic!("{at}: broker sent no frame"));
                assert_eq!(id, b, "{at}: frame for the wrong request");
                assert_eq!(
                    got,
                    with_request_id(frame_bytes(frame), b),
                    "{at}: frame bytes differ"
                );
                counts.frames_matched += 1;
                continue;
            }
            match msg["type"].as_str().unwrap() {
                "deviceRequest" => {
                    let t = msg["id"].as_u64().unwrap() as u32;
                    counts.requests += 1;
                    let is_core = msg["capability"] == CORE_CAPABILITIES;
                    if is_core && !r.broker.is_started() {
                        r.broker
                            .start(r.now)
                            .unwrap_or_else(|e| panic!("{at}: start refused: {e}"));
                    } else if !is_core {
                        let owner: Owner = serde_json::from_value(msg["owner"].clone()).unwrap();
                        assert!(r.activate(&owner), "{at}: activation refused");
                        let rev = find_revision(
                            msg["capability"].as_str().unwrap(),
                            msg["version"].as_u64().unwrap() as u32,
                        );
                        let mut download = None;
                        if rev.is_some_and(|r| r.data == DataPlane::BinaryDownload) {
                            let declared = msg["params"]["bytes"].as_u64().unwrap() as usize;
                            let mut bytes = download_frames(steps, i, t);
                            if bytes.is_empty() {
                                bytes = table
                                    .get(msg["params"]["sha256"].as_str().unwrap())
                                    .cloned()
                                    .unwrap_or_default();
                            }
                            bytes.resize(declared, 0);
                            download = Some(bytes);
                        }
                        let faulty = download.as_ref().is_some_and(|d| {
                            sha256_hex(d) != msg["params"]["sha256"].as_str().unwrap()
                        });
                        match r.broker.open(r.spec(msg, download), r.now) {
                            Ok(b) => {
                                assert!(!faulty, "{at}: broker announced bytes it does not send");
                                r.link(t, b);
                            }
                            Err(refusal) => {
                                // The transcript's server sends bytes that do
                                // not match its own announcement: the broker
                                // never announces such a download, and the
                                // client's success is the flagged violation.
                                assert!(faulty, "{at}: open refused: {refusal}");
                                assert_eq!(refusal.code, DeviceErrorCode::InvalidParams);
                                assert!(
                                    steps[i + 1..].iter().any(|s| s["dir"] == "c2s"
                                        && s["message"]["id"] == t
                                        && s["message"]["type"] == "deviceResponse"
                                        && s["message"].get("result").is_some()
                                        && s.get("expectViolation").is_some()),
                                    "{at}: a faulty download must end in a flagged success"
                                );
                                r.refused.insert(t);
                                counts.faulty_server_downloads += 1;
                                continue;
                            }
                        }
                    }
                    r.pump(&at);
                    let emitted = r
                        .emitted_requests
                        .pop_front()
                        .unwrap_or_else(|| panic!("{at}: broker emitted no request"));
                    assert!(r.emitted_requests.is_empty(), "{at}: extra requests");
                    let DeviceMessage::DeviceRequest(req) = &emitted else {
                        unreachable!()
                    };
                    if is_core {
                        r.link(t, req.id);
                        assert_eq!(r.broker.core_stream_id(), Some(req.id));
                    }
                    let mut want = msg.clone();
                    want["id"] = json!(req.id);
                    let mut got = request_value(&emitted);
                    if is_core {
                        // Host configuration: the first core stream's credit
                        // is the transcript's; a reopen reuses it.
                        got["initialCredit"] = want["initialCredit"].clone();
                    }
                    assert_eq!(got, want, "{at}: emitted request differs");
                }
                "deviceEvent" => {
                    let t = msg["id"].as_u64().unwrap() as u32;
                    if r.refused.contains(&t) {
                        continue;
                    }
                    let b = r.bid(t);
                    let control = &msg["control"];
                    if let Some(n) = control.get("renewLease").and_then(Value::as_u64) {
                        let n = n as u32;
                        let tl = r.transcript_lease.entry(t).or_default();
                        *tl = (*tl).max(n);
                        for _ in 0..10 {
                            if r.lease.get(&b).copied().unwrap_or(0) >= n || !r.broker.is_live(b) {
                                break;
                            }
                            r.now += 5_000;
                            r.broker.tick(r.now);
                            r.pump(&at);
                        }
                        assert!(
                            r.lease.get(&b).copied().unwrap_or(0) >= n,
                            "{at}: broker never renewed to {n}"
                        );
                        assert!(
                            r.broker.is_live(b),
                            "{at}: the request expired while renewing"
                        );
                    } else if control.get("cancel").is_some() {
                        if r.swept.contains(&b) {
                            assert_eq!(
                                r.cancels.get(&b),
                                Some(&1),
                                "{at}: swept request cancelled once"
                            );
                            continue;
                        }
                        assert!(r.broker.is_live(b), "{at}: cancel of a non-live request");
                        if r.broker.core_stream_id() == Some(b) {
                            // Planned reopen: retire the old stream first.
                            let next = steps[i + 1..]
                                .iter()
                                .find(|s| s["dir"] == "s2c" && s.get("ignored").is_none())
                                .expect("a reopen follows");
                            assert_eq!(
                                next["message"]["capability"], CORE_CAPABILITIES,
                                "{at}: core cancel is a reopen"
                            );
                            let new_id =
                                r.broker.reopen_core_capabilities(r.now).expect("reopened");
                            r.pump(&at);
                            assert_eq!(r.cancels.get(&b), Some(&1), "{at}: old stream cancelled");
                            let last = r.log.texts.last().unwrap();
                            assert!(
                                !is_cancel(last, b),
                                "{at}: the cancel precedes the new request"
                            );
                            assert_eq!(r.broker.core_stream_id(), Some(new_id));
                            counts.reopens += 1;
                            continue;
                        }
                        // An owner sweep when the consecutive cancels cover
                        // exactly one activation's live work; else a caller
                        // abandon.
                        let run_ids: Vec<u32> = steps[i..]
                            .iter()
                            .take_while(|s| {
                                s["dir"] == "s2c"
                                    && s["message"]["control"].get("cancel").is_some()
                                    && s.get("reaction").is_none()
                            })
                            .map(|s| r.bid(s["message"]["id"].as_u64().unwrap() as u32))
                            .collect();
                        let owner = r.emitted_owner(b);
                        let owned: HashSet<u32> = r.owned_live(&owner);
                        let run: HashSet<u32> = run_ids.iter().copied().collect();
                        if run.len() > 1 && run == owned {
                            if let Owner::Activation {
                                module_instance_id,
                                activation_id,
                            } = &owner
                            {
                                r.broker.owner_deactivated(
                                    module_instance_id,
                                    *activation_id,
                                    r.now,
                                );
                            }
                            r.pump(&at);
                            for id in &run {
                                assert_eq!(r.cancels.get(id), Some(&1), "{at}: swept {id}");
                                assert_eq!(
                                    r.settled.get(id).and_then(Outcome::code),
                                    Some(DeviceErrorCode::Cancelled)
                                );
                            }
                            r.swept.extend(run);
                            counts.sweeps += 1;
                        } else {
                            r.broker.cancel(b, r.now);
                            r.pump(&at);
                            assert_eq!(r.cancels.get(&b), Some(&1), "{at}: one cancel");
                            assert_eq!(
                                r.settled.get(&b).and_then(Outcome::code),
                                Some(DeviceErrorCode::Cancelled)
                            );
                        }
                    } else if control.get("grant").is_some() {
                        r.pump(&at);
                        let granted = r.grants_since.remove(&b).unwrap_or(0);
                        assert!(
                            granted > 0,
                            "{at}: the broker did not replenish where the transcript server did"
                        );
                        let outstanding = r
                            .broker
                            .outstanding_credit(b)
                            .filter(|&c| c > 0)
                            .or(r.broker.outstanding_event_credit(b))
                            .unwrap_or(0);
                        assert!(outstanding > 0, "{at}: sender starved");
                    } else {
                        panic!("{at}: unexpected server step {msg}");
                    }
                }
                other => panic!("{at}: unexpected server step type {other}"),
            }
            let log = r.take_log();
            if let Some(extra) = r.emitted_requests.front() {
                panic!("{at}: unclaimed request {}", request_value(extra));
            }
            assert!(log.closed.is_none(), "{at}: unexpected close");
            continue;
        }

        // ---- c2s: the client's step into the broker ----
        assert!(pending_reaction.is_none(), "{at}: missing server reaction");
        r.pump(&at);
        r.take_log();
        let t: Option<u32>;
        let mut is_response = false;
        let violations_before = r.broker.connection_violations();
        enum Input {
            Text(String),
            Frame(Vec<u8>),
        }
        let input = if let Some(frame) = step.get("frame") {
            let tid = frame["header"]["requestId"].as_u64().unwrap() as u32;
            t = Some(tid);
            Input::Frame(with_request_id(frame_bytes(frame), r.bid(tid)))
        } else if let Some(raw) = step["raw"].as_str() {
            let lenient: Option<Value> = serde_json::from_str(raw).ok();
            let tid = lenient
                .as_ref()
                .and_then(|v| v["id"].as_u64())
                .map(|x| x as u32);
            t = tid;
            let text = match tid {
                Some(tid) if r.bid(tid) != tid => {
                    raw.replace(&format!("\"id\":{tid}"), &format!("\"id\":{}", r.bid(tid)))
                }
                _ => raw.to_string(),
            };
            Input::Text(text)
        } else {
            let mut m = msg.clone();
            let tid = m["id"].as_u64().unwrap() as u32;
            t = Some(tid);
            is_response = m["type"] == "deviceResponse";
            let b = r.bid(tid);
            m["id"] = json!(b);
            if let Some(ack) = m["control"].get("leaseAck").and_then(Value::as_u64) {
                // The broker sends renewLease 1 WITH each request (§2.7): a
                // transcript whose server had not renewed yet sits below it.
                let offset = r.lease.get(&b).copied().unwrap_or(0) as i64
                    - r.transcript_lease.get(&tid).copied().unwrap_or(0) as i64;
                m["control"]["leaseAck"] = json!(ack as i64 + offset.max(0));
            }
            Input::Text(m.to_string())
        };
        if let Some(tid) = t {
            if r.refused.contains(&tid) {
                if category.is_some() {
                    seen_c2s_violations += 1; // prevented at the source
                }
                continue;
            }
        }
        let b = t.map(|tid| r.bid(tid));
        let was_live = b.is_some_and(|b| r.broker.is_live(b));
        let was_core = b.is_some() && r.broker.core_stream_id() == b;
        let cancels_before = b
            .map(|b| r.cancels.get(&b).copied().unwrap_or(0))
            .unwrap_or(0);
        match &input {
            Input::Text(text) => {
                r.broker.on_text(text, r.now);
            }
            Input::Frame(frame) => {
                r.broker.on_frame(frame, r.now);
            }
        }
        r.pump(&at);
        let log = r.take_log();
        let fed_live = was_live;

        if ignored {
            counts.ignored += 1;
            assert!(!fed_live, "{at}: an ignored step targets a live id");
            assert!(
                log.texts.is_empty() && log.settled.is_empty() && log.closed.is_none(),
                "{at}: ignored step had effects"
            );
            assert_eq!(r.broker.connection_violations(), violations_before, "{at}");
            continue;
        }

        let Some(cat) = category else {
            assert_eq!(
                r.broker.connection_violations(),
                violations_before,
                "{at}: unexpected connection-level violation"
            );
            assert!(
                log.closed.is_none(),
                "{at}: unexpected close {:?}",
                log.closed
            );
            let b = b.expect("attributable step");
            for m in &log.texts {
                assert!(!is_cancel(m, b), "{at}: unexpected cancel");
            }
            if fed_live && !r.broker.is_live(b) {
                assert!(is_response, "{at}: request ended by a non-terminal step");
                let outcome = r
                    .settled
                    .get(&b)
                    .unwrap_or_else(|| panic!("{at}: not settled"));
                if let Some(err) = msg.get("error") {
                    assert_eq!(
                        serde_json::to_value(outcome.code()).unwrap(),
                        err["code"],
                        "{at}"
                    );
                } else {
                    check_success(&at, &r, b, msg, outcome);
                    counts.successes += 1;
                }
            } else if fed_live {
                assert!(
                    !r.settled.contains_key(&b),
                    "{at}: settled by a non-terminal step"
                );
            }
            continue;
        };

        seen_c2s_violations += 1;
        counts.c2s_violations += 1;
        let next = steps.get(i + 1);
        let b = b.unwrap_or(0);
        if cat == "connection" {
            assert!(
                fed_live && !r.broker.is_live(b),
                "{at}: the core stream ended"
            );
            assert_eq!(r.broker.core_stream_id(), None);
            let (code, _) = log.closed.clone().expect("device plane closed");
            assert_eq!(code, 1012);
            assert!(r.broker.is_closed());
            assert_eq!(
                i,
                steps.len() - 1,
                "{at}: connection violations end the transcript"
            );
            counts.connection_closes += 1;
            ended = true;
            continue;
        }
        let request_level = fed_live && !r.broker.is_live(b);
        if !request_level {
            assert_eq!(cat, "malformed", "{at}: only malformed is connection-level");
            assert_eq!(
                r.broker.connection_violations(),
                violations_before + 1,
                "{at}: counted"
            );
            if fed_live {
                assert!(r.broker.is_live(b), "{at}: the named request lives on");
            }
            assert!(
                log.texts.is_empty() && log.settled.is_empty(),
                "{at}: no request touched"
            );
            assert!(
                next.is_none_or(|n| n.get("reaction").is_none()),
                "{at}: no reaction"
            );
            counts.connection_level += 1;
            continue;
        }
        counts.request_level += 1;
        if was_core {
            // The violated stream was core.capabilities: cancel, then the
            // device plane closes.
            let cancel_idx = log
                .texts
                .iter()
                .position(|m| is_cancel(m, b))
                .expect("cancel sent");
            assert_eq!(cancel_idx, 0, "{at}: the reaction goes out first");
            assert!(r.broker.is_closed());
        } else {
            let outcome = r
                .settled
                .get(&b)
                .unwrap_or_else(|| panic!("{at}: violation did not settle"));
            assert_eq!(
                outcome.code(),
                Some(DeviceErrorCode::InvalidParams),
                "{at}: {outcome:?}"
            );
            assert_eq!(r.broker.connection_violations(), violations_before, "{at}");
        }
        if is_response {
            assert_eq!(
                r.cancels.get(&b).copied().unwrap_or(0),
                cancels_before,
                "{at}: no cancel after the client's own terminal"
            );
            assert!(
                next.is_none_or(|n| n.get("reaction").is_none()),
                "{at}: no reaction follows a terminal"
            );
        } else {
            assert!(
                next.is_some_and(|n| n.get("reaction").is_some()),
                "{at}: reaction step expected"
            );
            pending_reaction = Some((t.unwrap(), cancels_before));
        }
    }
    assert!(
        pending_reaction.is_none(),
        "{name}: transcript ends before the reaction"
    );
    assert_eq!(
        seen_c2s_violations, flagged_c2s_violations,
        "{name}: every c2s violation exercised"
    );
    if !ended {
        assert!(
            r.log.closed.is_none() && !r.broker.is_closed(),
            "{name}: the plane must stay up"
        );
    }
    counts.transcripts += 1;
}

impl Replay {
    /// The owner the broker put on the wire for broker id `b`.
    fn emitted_owner(&self, b: u32) -> Owner {
        self.owners
            .get(&b)
            .cloned()
            .expect("request emitted by the broker")
    }

    /// Live broker requests carrying exactly `owner`.
    fn owned_live(&self, owner: &Owner) -> HashSet<u32> {
        self.owners
            .iter()
            .filter(|(id, o)| *o == owner && self.broker.is_live(**id))
            .map(|(id, _)| *id)
            .collect()
    }
}

fn check_success(at: &str, r: &Replay, b: u32, msg: &Value, outcome: &Outcome) {
    let Outcome::Ok {
        result,
        blobs,
        simulated,
        ..
    } = outcome
    else {
        panic!("{at}: expected success, got {outcome:?}");
    };
    assert_eq!(result, &msg["result"], "{at}: result passes through");
    assert_eq!(
        *simulated,
        msg.get("simulated").is_some(),
        "{at}: simulated flag"
    );
    let plane = r.planes.get(&b).copied();
    let items: Vec<&Value> = match (result.get("items"), result.get("item")) {
        (Some(Value::Array(items)), _) => items.iter().collect(),
        (_, Some(item)) => vec![item],
        _ => Vec::new(),
    };
    match plane {
        Some(DataPlane::BinaryUpload) if !items.is_empty() && r.delivered.contains_key(&b) => {
            // Streamed: the handler received exactly the one verified item.
            assert!(blobs.is_empty());
            let bytes = &r.delivered[&b];
            assert_eq!(items.len(), 1);
            assert_eq!(
                bytes.len() as u64,
                items[0]["bytes"].as_u64().unwrap(),
                "{at}"
            );
            assert_eq!(
                sha256_hex(bytes),
                items[0]["sha256"],
                "{at}: delivered bytes verify"
            );
        }
        Some(DataPlane::BinaryUpload) => {
            assert_eq!(blobs.len(), items.len(), "{at}: one blob per item");
            for (blob, item) in blobs.iter().zip(&items) {
                assert_eq!(u64::from(blob.channel), item["channel"].as_u64().unwrap());
                assert_eq!(blob.content_type, item["contentType"].as_str().unwrap());
                assert_eq!(blob.bytes.len() as u64, item["bytes"].as_u64().unwrap());
                assert_eq!(
                    sha256_hex(&blob.bytes),
                    item["sha256"],
                    "{at}: blob verifies"
                );
            }
        }
        _ => assert!(blobs.is_empty()),
    }
}

#[test]
fn every_wire_transcript_replays_through_the_broker_as_server() {
    let docs = load_all();
    assert!(docs.len() > 100, "the shared corpus is present");
    let table = download_table(&docs);
    assert!(!table.is_empty());
    let mut counts = Counts::default();
    let mut by_name = BTreeMap::new();
    for (name, doc) in &docs {
        run(name, doc, &table, &mut counts);
        by_name.insert(name.clone(), ());
    }
    eprintln!("{counts:#?}");
    assert_eq!(counts.transcripts, docs.len());
    // Coverage floors: the corpus exercises every reaction path.
    assert!(counts.c2s_violations > 40, "{counts:?}");
    assert!(counts.request_level > 30, "{counts:?}");
    assert!(counts.connection_level >= 3, "{counts:?}");
    assert!(counts.connection_closes >= 1, "{counts:?}");
    assert!(counts.s2c_refusals >= 10, "{counts:?}");
    assert!(counts.frames_matched >= 4, "{counts:?}");
    assert!(counts.ignored >= 15, "{counts:?}");
    assert!(counts.successes >= 20, "{counts:?}");
    assert!(counts.sweeps >= 1, "{counts:?}");
    assert!(counts.reopens >= 1, "{counts:?}");
    assert!(counts.faulty_server_downloads >= 1, "{counts:?}");
}
