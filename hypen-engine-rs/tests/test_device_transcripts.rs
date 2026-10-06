//! Device Capability Protocol transcript runner (RFC 001 §6 Phase 0).
//!
//! The reference **stateful** model every SDK's async runner mirrors. It
//! replays each fixture under `engine-compatibility-tests/fixtures/device/
//! transcripts/` as an observer of one physical connection. The fixture
//! format and every rule below are specified in
//! `engine-compatibility-tests/fixtures/device/README.md`; this file is the
//! executable form of that README.
//!
//! Per step it checks:
//!
//! - **decoding**: the RFC 001 §2.1 JSON limits, strict closed decoding,
//!   canonical round-trip, and agreement with the exported JSON Schemas
//!   (envelope for every message; the selected revision's
//!   `params`/`result`/`event` definition for payloads). Text breaking the
//!   JSON limits, and bad frame headers, are *connection-level* `malformed`
//!   violations attributed to no request; a message within the limits with a
//!   clean device `type` and `id` that fails the envelope is a *known-id*
//!   invalid message when its id is live;
//! - **liveness before direction**: a message for an id that is not live
//!   for its receiver is ignored whatever its direction or validity; a
//!   step aimed at a non-live id MUST be flagged `"ignored": true`, and a
//!   flagged step MUST in fact be stale. The client keeps a high-water mark:
//!   duplicate/older requests are dropped;
//! - **connection model**: the negotiated `ack` (default: every registry
//!   capability, binary; a subset of the server advertisement) is the
//!   ceiling of the live selection for the whole connection; every
//!   `core.capabilities` snapshot recomputes it as ack ∩ snapshot (narrow or
//!   restore, never widen); app requests only after
//!   the core stream opened; at most one live core stream; a terminal on the
//!   live core stream closes the device connection; a request outside the
//!   live selection or registry is `unsupported`; `activationId` never goes
//!   backwards per `moduleInstanceId`;
//! - **directions** and per-revision **admission** (`validate_request`);
//! - **credit** (bytes or events never beyond granted credit; outstanding
//!   credit within `maxOutstandingCredit`; `paused` reports transitions and a
//!   paused sender sends no data), **lease** (first renewal is 1, then
//!   strictly increasing; acks only for sent sequences of that request),
//!   **progress** (never back to `pendingConsent` after `running` or data);
//! - **blobs**: `blobStart` before bytes, unique channels below `maxCount`,
//!   metadata that fits the request (`validate_blob_start_for_request`),
//!   non-empty chunks ≤ 64 KiB, contiguous seq per lossless channel, bytes
//!   within the declaration when `bytes` was declared and within
//!   `maxItemBytes` always, and at the terminal the exact announced item set
//!   with actual byte counts and SHA-256 of the received payloads (uploads),
//!   or the declared download size/hash before a success receipt.
//!
//! A step flagged `"expectViolation": "<category>"` must produce exactly that
//! violation. A request-level violation is immediately followed by its
//! `"reaction": true` step — a client terminal error (`unsupported` or
//! `invalidParams`) when the client detected it, a server `cancel` when the
//! server did (none when the offending message was the client's own
//! terminal). `malformed` connection-level violations have no reaction and
//! change no request; `connection` violations close the device connection and
//! end the transcript. Handshake-selection fixtures (`hello` present) pin
//! `select_device_ack`. Frame golden bytes live in `frames.json`.

use hypen_engine::serialize::device::{
    attribute_invalid, decode_event, find_revision, parse_strict_json, select_device_ack,
    validate_blob_start_for_request, validate_payload, validate_request, CapabilitiesEvent,
    CapabilityOffer, CapabilityRevision, ChannelSeq, Control, DataPlane, DeviceAck,
    DeviceErrorCode, DeviceHello, DeviceMessage, FrameError, FrameHeader, MessageKind, Mode, Owner,
    PayloadKind, ProgressState, TypedEvent, CORE_CAPABILITIES, FRAME_HEADER_LEN,
    MAX_BULK_CHUNK_BYTES,
};
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

fn device_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine-compatibility-tests")
}

// ---------------------------------------------------------------------------
// Strict fixture loading (duplicate keys are a fixture error)
// ---------------------------------------------------------------------------

struct FixtureValue(Value);

impl<'de> Deserialize<'de> for FixtureValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = FixtureValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_bool<E>(self, v: bool) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::from(v)))
            }
            fn visit_u64<E>(self, v: u64) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::from(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<FixtureValue, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| FixtureValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite"))
            }
            fn visit_str<E>(self, v: &str) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::String(v.into())))
            }
            fn visit_unit<E>(self) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<FixtureValue, A::Error> {
                let mut out = Vec::new();
                while let Some(FixtureValue(v)) = s.next_element()? {
                    out.push(v);
                }
                Ok(FixtureValue(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<FixtureValue, A::Error> {
                let mut out = Map::new();
                while let Some(k) = m.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom(format!("duplicate key `{k}`")));
                    }
                    let FixtureValue(v) = m.next_value()?;
                    out.insert(k, v);
                }
                Ok(FixtureValue(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}

fn parse_fixture(text: &str) -> Result<Value, String> {
    serde_json::from_str::<FixtureValue>(text)
        .map(|FixtureValue(v)| v)
        .map_err(|e| e.to_string())
}

fn load(path: &Path) -> Value {
    let raw = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_fixture(&raw).unwrap_or_else(|e| panic!("{}: invalid fixture JSON: {e}", path.display()))
}

fn keys_within(obj: &Value, allowed: &[&str], required: &[&str], at: &str) -> Result<(), String> {
    let map = obj.as_object().ok_or(format!("{at}: not an object"))?;
    for k in map.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("{at}: unknown key `{k}`"));
        }
    }
    for k in required {
        if !map.contains_key(*k) {
            return Err(format!("{at}: missing key `{k}`"));
        }
    }
    Ok(())
}

const CATEGORIES: &[&str] = &[
    "malformed",
    "invalidPayload",
    "unsupported",
    "direction",
    "credit",
    "lease",
    "sequence",
    "blob",
    "owner",
    "connection",
];

/// The fixture format itself is closed: unknown document/step/frame keys,
/// flags that are not `true`, unknown categories, and steps carrying more or
/// less than one of `message`/`raw`/`frame` are fixture errors.
fn validate_fixture(doc: &Value) -> Result<(), String> {
    if doc.get("hello").is_some() {
        return keys_within(
            doc,
            &[
                "name",
                "description",
                "hello",
                "serverProtocolVersions",
                "serverBinary",
                "serverCapabilities",
                "expectAck",
            ],
            &[
                "name",
                "description",
                "hello",
                "serverProtocolVersions",
                "serverBinary",
                "serverCapabilities",
                "expectAck",
            ],
            "handshake fixture",
        );
    }
    keys_within(
        doc,
        &[
            "name",
            "description",
            "protocol",
            "ack",
            "serverCapabilities",
            "steps",
        ],
        &["name", "description", "protocol", "steps"],
        "transcript",
    )?;
    if doc["protocol"] != 1 {
        return Err("only protocol 1 transcripts are defined".into());
    }
    let steps = doc["steps"].as_array().ok_or("steps is not an array")?;
    if steps.is_empty() {
        return Err("no steps".into());
    }
    for (i, step) in steps.iter().enumerate() {
        let at = format!("step {i}");
        keys_within(
            step,
            &[
                "dir",
                "message",
                "raw",
                "frame",
                "ignored",
                "expectViolation",
                "reaction",
            ],
            &["dir"],
            &at,
        )?;
        if !matches!(step["dir"].as_str(), Some("s2c" | "c2s")) {
            return Err(format!("{at}: dir must be s2c or c2s"));
        }
        let kinds = ["message", "raw", "frame"]
            .iter()
            .filter(|k| step.get(**k).is_some())
            .count();
        if kinds != 1 {
            return Err(format!("{at}: exactly one of message/raw/frame"));
        }
        if step.get("raw").is_some_and(|r| !r.is_string()) {
            return Err(format!("{at}: raw is JSON text"));
        }
        for flag in ["ignored", "reaction"] {
            if step.get(flag).is_some_and(|v| v != &Value::Bool(true)) {
                return Err(format!("{at}: {flag} is true when present"));
            }
        }
        let flags = ["ignored", "reaction", "expectViolation"]
            .iter()
            .filter(|k| step.get(**k).is_some())
            .count();
        if flags > 1 {
            return Err(format!(
                "{at}: ignored/reaction/expectViolation are exclusive"
            ));
        }
        if let Some(c) = step.get("expectViolation") {
            if !c.as_str().is_some_and(|c| CATEGORIES.contains(&c)) {
                return Err(format!("{at}: unknown violation category {c}"));
            }
        }
        if let Some(f) = step.get("frame") {
            keys_within(
                f,
                &["header", "hex", "payloadHex", "payloadFill"],
                &["header", "hex"],
                &at,
            )?;
            keys_within(
                &f["header"],
                &["version", "flags", "channel", "requestId", "seq"],
                &["version", "flags", "channel", "requestId", "seq"],
                &at,
            )?;
            if f.get("payloadHex").is_some() && f.get("payloadFill").is_some() {
                return Err(format!("{at}: payloadHex and payloadFill are exclusive"));
            }
            if let Some(fill) = f.get("payloadFill") {
                keys_within(fill, &["byte", "length"], &["byte", "length"], &at)?;
            }
        }
    }
    Ok(())
}

fn hex_decode(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd-length hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Frame bytes: `hex`, followed by `payloadFill` when present.
fn frame_bytes(frame: &Value) -> Vec<u8> {
    let mut bytes = hex_decode(frame["hex"].as_str().expect("frame hex"));
    if let Some(fill) = frame.get("payloadFill") {
        let byte = u8::try_from(fill["byte"].as_u64().expect("fill byte")).expect("byte");
        let len = usize::try_from(fill["length"].as_u64().expect("fill length")).unwrap();
        bytes.resize(bytes.len() + len, byte);
    }
    bytes
}

// ---------------------------------------------------------------------------
// Exported schemas
// ---------------------------------------------------------------------------

struct Schemas {
    envelope: jsonschema::Validator,
    /// `(capability, version, def)` → validator for `#/$defs/<def>`.
    payloads: HashMap<(String, u32, &'static str), jsonschema::Validator>,
}

fn def_validator(doc: &Value, def: &str) -> jsonschema::Validator {
    let mut schema = doc.clone();
    let obj = schema.as_object_mut().unwrap();
    obj.remove("oneOf");
    obj.remove("anyOf");
    obj.insert("$ref".into(), Value::String(format!("#/$defs/{def}")));
    jsonschema::validator_for(&schema).unwrap_or_else(|e| panic!("#{def}: {e}"))
}

impl Schemas {
    fn load() -> Schemas {
        let dir = device_dir().join("schema/device");
        let envelope = jsonschema::validator_for(&load(&dir.join("envelope-v1.schema.json")))
            .expect("envelope schema compiles");
        let mut payloads = HashMap::new();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let file = path.file_name().unwrap().to_string_lossy().into_owned();
            let Some(stem) = file.strip_suffix(".schema.json") else {
                continue;
            };
            if stem.starts_with("envelope-") || stem.starts_with("handshake-") {
                continue;
            }
            let (name, version) = stem.rsplit_once("-v").expect("name-vN");
            let version: u32 = version.parse().expect("revision number");
            let doc = load(&path);
            for def in ["params", "result", "event"] {
                payloads.insert((name.to_string(), version, def), def_validator(&doc, def));
            }
        }
        Schemas { envelope, payloads }
    }

    fn payload_ok(
        &self,
        capability: &str,
        version: u32,
        kind: PayloadKind,
        v: &Value,
    ) -> Option<bool> {
        let def = match kind {
            PayloadKind::Params => "params",
            PayloadKind::Result => "result",
            PayloadKind::Event => "event",
        };
        self.payloads
            .get(&(capability.to_string(), version, def))
            .map(|val| val.is_valid(v))
    }
}

// ---------------------------------------------------------------------------
// Connection state model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dir {
    S2c,
    C2s,
}

/// Violation categories shared with the fixture format (README).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Category {
    Malformed,
    InvalidPayload,
    Unsupported,
    Direction,
    Credit,
    Lease,
    Sequence,
    Blob,
    Owner,
    Connection,
}

impl Category {
    fn parse(s: &str) -> Category {
        match s {
            "malformed" => Category::Malformed,
            "invalidPayload" => Category::InvalidPayload,
            "unsupported" => Category::Unsupported,
            "direction" => Category::Direction,
            "credit" => Category::Credit,
            "lease" => Category::Lease,
            "sequence" => Category::Sequence,
            "blob" => Category::Blob,
            "owner" => Category::Owner,
            "connection" => Category::Connection,
            other => panic!("unknown violation category {other}"),
        }
    }
}

#[derive(Debug)]
struct Violation {
    category: Category,
    why: String,
    /// The live request it is attributed to; `None` = connection-level.
    target: Option<u32>,
    /// The offending message was the client's own terminal response.
    terminal: bool,
}

#[derive(Debug)]
enum Outcome {
    Ignored,
    Violation(Violation),
}

fn violation<T>(
    category: Category,
    target: Option<u32>,
    why: impl Into<String>,
) -> Result<T, Outcome> {
    Err(Outcome::Violation(Violation {
        category,
        why: why.into(),
        target,
        terminal: false,
    }))
}

/// The wire reaction a request-level violation requires next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expect {
    ClientTerminal { id: u32, code: DeviceErrorCode },
    ServerCancel { id: u32 },
}

struct Channel {
    content_type: String,
    /// `blobStart.bytes` when declared (always for a download).
    declared: Option<u64>,
    received: Vec<u8>,
    seq: ChannelSeq,
}

struct Request {
    capability: String,
    version: u32,
    rev: &'static CapabilityRevision,
    params: Value,
    /// Live from the client's point of view (s2c traffic is judged here).
    client_live: bool,
    /// Live from the server's point of view (c2s traffic is judged here).
    server_live: bool,
    /// Granted, unspent data credit (bytes or events).
    credit: u64,
    /// Channel limit: params `maxCount` where defined, else `max_items`.
    max_count: u64,
    channels: BTreeMap<u16, Channel>,
    /// The data sender reported `paused: true` and has not resumed.
    paused: bool,
    last_renewal: u32,
    renewals: BTreeSet<u32>,
    /// Latest progress state; data implies `running`.
    progress: Option<ProgressState>,
    data_seen: bool,
}

impl Request {
    fn live(&self, dir: Dir) -> bool {
        match dir {
            Dir::S2c => self.client_live,
            Dir::C2s => self.server_live,
        }
    }

    fn retire(&mut self) {
        self.client_live = false;
        self.server_live = false;
    }

    /// Who receives data (and therefore grants credit) on this plane.
    fn data_receiver(&self) -> Option<Dir> {
        match self.rev.data {
            DataPlane::None => None,
            // Grants flow receiver → sender: server grants for c2s data.
            DataPlane::JsonEvents | DataPlane::BinaryUpload => Some(Dir::S2c),
            DataPlane::BinaryDownload => Some(Dir::C2s),
        }
    }

    /// Direction data (frames, `paused`) flows on this plane.
    fn data_direction(&self) -> Option<Dir> {
        match self.rev.data {
            DataPlane::None => None,
            DataPlane::JsonEvents | DataPlane::BinaryUpload => Some(Dir::C2s),
            DataPlane::BinaryDownload => Some(Dir::S2c),
        }
    }
}

struct Conn<'a> {
    schemas: &'a Schemas,
    high_water: u32,
    requests: HashMap<u32, Request>,
    /// The ack's `(name, version)` pairs: the live selection's ceiling.
    negotiated: BTreeSet<(String, u32)>,
    /// Live selection: `(name, version)` a new request may name.
    selection: BTreeSet<(String, u32)>,
    core_opened: bool,
    live_core: Option<u32>,
    /// Highest `activationId` seen per `moduleInstanceId`.
    activations: HashMap<String, u32>,
}

/// Default `ack`: every registry capability at its highest revision, binary.
fn default_ack() -> DeviceAck {
    let caps: Vec<Value> = hypen_engine::serialize::device::registry()
        .iter()
        .map(
            |c| serde_json::json!({"name": c.name, "version": c.revisions.last().unwrap().version}),
        )
        .collect();
    DeviceAck::from_value(&serde_json::json!({
        "protocolVersion": 1, "binary": true, "capabilities": caps
    }))
    .unwrap()
}

impl<'a> Conn<'a> {
    fn new(schemas: &'a Schemas, doc: &Value) -> Self {
        let ack = match doc.get("ack") {
            Some(v) => {
                DeviceAck::from_value(v).expect("transcript ack must be a valid sessionAck.device")
            }
            None => default_ack(),
        };
        assert!(
            ack.capabilities
                .iter()
                .any(|c| c.name == CORE_CAPABILITIES && c.version == 1),
            "an enabled device connection selects core.capabilities@1"
        );
        let server: Vec<CapabilityOffer> = match doc.get("serverCapabilities") {
            Some(v) => serde_json::from_value(v.clone()).expect("serverCapabilities"),
            None => ack
                .capabilities
                .iter()
                .map(|c| CapabilityOffer {
                    name: c.name.clone(),
                    versions: vec![c.version],
                })
                .collect(),
        };
        // The ack was negotiated against the server advertisement: every
        // selected revision is one the server offered (first entry wins).
        for c in &ack.capabilities {
            assert!(
                server
                    .iter()
                    .find(|s| s.name == c.name)
                    .is_some_and(|s| s.versions.contains(&c.version)),
                "ack entry {}@{} is not in serverCapabilities",
                c.name,
                c.version
            );
        }
        let negotiated: BTreeSet<(String, u32)> = ack
            .capabilities
            .iter()
            .map(|c| (c.name.clone(), c.version))
            .collect();
        Conn {
            schemas,
            high_water: 0,
            requests: HashMap::new(),
            selection: negotiated.clone(),
            negotiated,
            core_opened: false,
            live_core: None,
            activations: HashMap::new(),
        }
    }

    /// A snapshot replaces the client advertisement: the live selection is
    /// the negotiated ack restricted to the entries whose revision the
    /// snapshot still lists (§2.2 — the ack is the ceiling; a snapshot
    /// narrows or restores within it, never widens it).
    fn recompute_selection(&mut self, snapshot: &CapabilitiesEvent) {
        self.selection = self
            .negotiated
            .iter()
            .filter(|(name, version)| {
                snapshot
                    .capabilities
                    .iter()
                    .any(|c| c.name == *name && c.versions.contains(version))
            })
            .cloned()
            .collect();
    }

    fn retire(&mut self, id: u32) {
        if let Some(r) = self.requests.get_mut(&id) {
            r.retire();
        }
        if self.live_core == Some(id) {
            self.live_core = None;
        }
    }

    fn live(&self, id: u32, dir: Dir) -> bool {
        self.requests.get(&id).is_some_and(|r| r.live(dir))
    }

    fn step(&mut self, dir: Dir, step: &Value) -> Result<(), Outcome> {
        if let Some(message) = step.get("message") {
            let text = serde_json::to_string(message).unwrap();
            self.message(dir, &text, Some(message))
        } else if let Some(raw) = step.get("raw") {
            self.message(dir, raw.as_str().unwrap(), None)
        } else {
            self.frame(dir, &step["frame"])
        }
    }

    fn message(&mut self, dir: Dir, text: &str, value: Option<&Value>) -> Result<(), Outcome> {
        // JSON limits first: text breaking them is attributable to no request.
        let parsed = match parse_strict_json(text) {
            Ok(v) => v,
            Err(e) => return violation(Category::Malformed, None, e.to_string()),
        };
        let schema_ok = self.schemas.envelope.is_valid(&parsed);
        let msg = match DeviceMessage::decode_value(&parsed) {
            Ok(msg) => msg,
            Err(e) => return self.malformed(dir, &parsed, e.to_string()),
        };
        assert!(
            schema_ok,
            "Rust decoded a message envelope-v1 rejects: {text}"
        );
        if let Some(value) = value {
            assert_eq!(
                &serde_json::to_value(&msg).unwrap(),
                value,
                "wire JSON must round-trip"
            );
        }

        match msg {
            DeviceMessage::DeviceRequest(r) => {
                if dir == Dir::C2s {
                    // Liveness before direction: only a live server id is known.
                    if !self.live(r.id, Dir::C2s) {
                        return Err(Outcome::Ignored);
                    }
                    return violation(
                        Category::Direction,
                        Some(r.id),
                        "deviceRequest from the client",
                    );
                }
                if r.id <= self.high_water {
                    return Err(Outcome::Ignored); // duplicate/older: dropped unexecuted
                }
                self.high_water = r.id;
                self.request(r)
            }
            DeviceMessage::DeviceResponse(r) => {
                if !self.live(r.id, dir) {
                    return Err(Outcome::Ignored);
                }
                if dir == Dir::S2c {
                    return violation(
                        Category::Direction,
                        Some(r.id),
                        "deviceResponse from the server",
                    );
                }
                if self.live_core == Some(r.id) {
                    return violation(
                        Category::Connection,
                        Some(r.id),
                        "terminal on the live core.capabilities stream",
                    );
                }
                let terminal = |o: Outcome| match o {
                    Outcome::Violation(mut v) => {
                        v.terminal = true;
                        Outcome::Violation(v)
                    }
                    other => other,
                };
                let req = &self.requests[&r.id];
                if let Some(result) = &r.result {
                    self.payload(req, r.id, PayloadKind::Result, result)
                        .map_err(terminal)?;
                    verify_terminal(req, r.id, result).map_err(terminal)?;
                }
                self.retire(r.id);
                Ok(())
            }
            DeviceMessage::DeviceEvent(e) => {
                if !self.live(e.id, dir) {
                    return Err(Outcome::Ignored);
                }
                match (&e.event, &e.control) {
                    (Some(event), None) => {
                        if dir != Dir::C2s {
                            return violation(
                                Category::Direction,
                                Some(e.id),
                                "capability event from the server",
                            );
                        }
                        self.event(e.id, event)
                    }
                    (None, Some(control)) => self.control(dir, e.id, control),
                    _ => unreachable!("validated XOR"),
                }
            }
        }
    }

    /// A message within the JSON limits that failed the envelope: a known-id
    /// invalid message when its clean `type`/`id` names a live id, ignored for
    /// a non-live id, connection-level otherwise.
    fn malformed(&mut self, dir: Dir, parsed: &Value, why: String) -> Result<(), Outcome> {
        let Some((kind, id)) = attribute_invalid(parsed) else {
            return violation(Category::Malformed, None, why);
        };
        match (kind, dir) {
            (MessageKind::Request, Dir::S2c) => {
                if id <= self.high_water {
                    return Err(Outcome::Ignored);
                }
                self.high_water = id;
                violation(Category::Malformed, Some(id), why)
            }
            _ => {
                if !self.live(id, dir) {
                    return Err(Outcome::Ignored);
                }
                let terminal = kind == MessageKind::Response && dir == Dir::C2s;
                Err(Outcome::Violation(Violation {
                    category: Category::Malformed,
                    why,
                    target: Some(id),
                    terminal,
                }))
            }
        }
    }

    fn request(
        &mut self,
        r: hypen_engine::serialize::device::DeviceRequest,
    ) -> Result<(), Outcome> {
        let id = Some(r.id);
        let is_core = r.capability == CORE_CAPABILITIES;
        if is_core {
            if let Some(core) = self.live_core {
                if self.live(core, Dir::C2s) {
                    return violation(
                        Category::Connection,
                        id,
                        "a second live core.capabilities stream",
                    );
                }
            }
        } else if !self.core_opened {
            return violation(
                Category::Connection,
                id,
                "app request before core.capabilities opened",
            );
        }
        if find_revision(&r.capability, r.version).is_none() {
            return violation(Category::Unsupported, id, "revision not in the registry");
        }
        // core.capabilities@1 is always available on an enabled connection.
        if !is_core && !self.selection.contains(&(r.capability.clone(), r.version)) {
            return violation(
                Category::Unsupported,
                id,
                "revision not in the live selection",
            );
        }
        if let Owner::Activation {
            module_instance_id,
            activation_id,
        } = &r.owner
        {
            let seen = self
                .activations
                .entry(module_instance_id.clone())
                .or_insert(0);
            if activation_id < seen {
                return violation(Category::Owner, id, "activationId went backwards");
            }
            *seen = *activation_id;
        }
        // Schema/Rust agreement on the params payload.
        if self
            .schemas
            .payload_ok(&r.capability, r.version, PayloadKind::Params, &r.params)
            == Some(false)
        {
            assert!(
                validate_payload(&r.capability, r.version, PayloadKind::Params, &r.params).is_err(),
                "Rust accepts params its exported schema rejects: {}",
                r.params
            );
        }
        let rev = match validate_request(&r) {
            Ok(rev) => rev,
            Err(rej) => {
                let category = if rej.code == DeviceErrorCode::Unsupported {
                    Category::Unsupported
                } else {
                    Category::InvalidPayload
                };
                return violation(category, id, rej.reason);
            }
        };
        let mut req = Request {
            capability: r.capability.clone(),
            version: r.version,
            rev,
            params: r.params.clone(),
            client_live: true,
            server_live: true,
            credit: r.initial_credit,
            max_count: u64::from(rev.max_items),
            channels: BTreeMap::new(),
            paused: false,
            last_renewal: 0,
            renewals: BTreeSet::new(),
            progress: None,
            data_seen: false,
        };
        if let Some(n) = r.params.get("maxCount").and_then(Value::as_u64) {
            req.max_count = n;
        }
        if rev.data == DataPlane::BinaryDownload {
            // The request is the announcement (file.save channel 0).
            let p = &r.params;
            req.channels.insert(
                p["channel"].as_u64().unwrap() as u16,
                Channel {
                    content_type: p["contentType"].as_str().unwrap().into(),
                    declared: p["bytes"].as_u64(),
                    received: Vec::new(),
                    seq: ChannelSeq::default(),
                },
            );
        }
        if is_core {
            self.core_opened = true;
            self.live_core = Some(r.id);
        }
        self.requests.insert(r.id, req);
        Ok(())
    }

    fn payload(&self, req: &Request, id: u32, kind: PayloadKind, v: &Value) -> Result<(), Outcome> {
        let rust = validate_payload(&req.capability, req.version, kind, v);
        if self
            .schemas
            .payload_ok(&req.capability, req.version, kind, v)
            == Some(false)
        {
            assert!(
                rust.is_err(),
                "Rust accepts a {kind:?} its exported schema rejects: {v}"
            );
        }
        rust.or_else(|e| violation(Category::InvalidPayload, Some(id), format!("{kind:?}: {e}")))
    }

    fn event(&mut self, id: u32, event: &Value) -> Result<(), Outcome> {
        let req = &self.requests[&id];
        let typed = decode_event(&req.capability, req.version, event);
        if self
            .schemas
            .payload_ok(&req.capability, req.version, PayloadKind::Event, event)
            == Some(false)
        {
            assert!(
                typed.is_err(),
                "Rust accepts an event its schema rejects: {event}"
            );
        }
        let typed = typed.or_else(|e| violation(Category::InvalidPayload, Some(id), e))?;
        let is_live_core = self.live_core == Some(id);
        let snapshot = match &typed {
            TypedEvent::Capabilities(s) => Some(s.clone()),
            _ => None,
        };
        let req = self.requests.get_mut(&id).unwrap();
        match typed {
            TypedEvent::Progress(p) => {
                // Optional and credit-free, but never back to pendingConsent.
                if p.state == ProgressState::PendingConsent
                    && (req.progress == Some(ProgressState::Running) || req.data_seen)
                {
                    return violation(
                        Category::InvalidPayload,
                        Some(id),
                        "progress went back to pendingConsent",
                    );
                }
                req.progress = Some(p.state);
                Ok(())
            }
            TypedEvent::BlobStart(bs) => {
                if u64::from(bs.channel) >= req.max_count {
                    return violation(
                        Category::Blob,
                        Some(id),
                        "blobStart channel beyond maxCount",
                    );
                }
                if req.channels.contains_key(&bs.channel) {
                    return violation(Category::Blob, Some(id), "duplicate blobStart channel");
                }
                if let Err(why) =
                    validate_blob_start_for_request(&req.capability, req.version, &req.params, &bs)
                {
                    return violation(Category::Blob, Some(id), why);
                }
                req.data_seen = true;
                req.channels.insert(
                    bs.channel,
                    Channel {
                        content_type: bs.content_type,
                        declared: bs.bytes,
                        received: Vec::new(),
                        seq: ChannelSeq::default(),
                    },
                );
                Ok(())
            }
            TypedEvent::Capabilities(_) | TypedEvent::BluetoothDevice(_) => {
                if req.paused {
                    return violation(Category::Credit, Some(id), "stream event while paused");
                }
                // JSON stream credit counts events.
                if req.credit == 0 {
                    return violation(Category::Credit, Some(id), "stream event without credit");
                }
                req.credit -= 1;
                req.data_seen = true;
                // Only the live core stream's snapshots replace the selection.
                if let (Some(snapshot), true) = (snapshot, is_live_core) {
                    self.recompute_selection(&snapshot);
                }
                Ok(())
            }
        }
    }

    fn control(&mut self, dir: Dir, id: u32, control: &Control) -> Result<(), Outcome> {
        // Liveness was checked by the caller; direction next.
        match control {
            Control::Cancel { .. } | Control::RenewLease { .. } if dir != Dir::S2c => {
                return violation(
                    Category::Direction,
                    Some(id),
                    "cancel/renewLease from the client",
                );
            }
            Control::LeaseAck { .. } if dir != Dir::C2s => {
                return violation(Category::Direction, Some(id), "leaseAck from the server");
            }
            _ => {}
        }
        let req = self.requests.get_mut(&id).unwrap();
        match *control {
            Control::Cancel { .. } => {
                self.retire(id); // server retires at send; the client stops
                Ok(())
            }
            Control::RenewLease { renew_lease } => {
                if req.last_renewal == 0 && renew_lease != 1 {
                    return violation(Category::Lease, Some(id), "first renewal is not sequence 1");
                }
                if renew_lease <= req.last_renewal {
                    return violation(Category::Lease, Some(id), "renewal sequence not increasing");
                }
                req.last_renewal = renew_lease;
                req.renewals.insert(renew_lease);
                Ok(())
            }
            Control::LeaseAck { lease_ack } => {
                if !req.renewals.contains(&lease_ack) {
                    return violation(Category::Lease, Some(id), "ack for a sequence never sent");
                }
                Ok(()) // repeated/older acks are legal and refresh nothing
            }
            Control::Grant { grant } => {
                match req.data_receiver() {
                    None => {
                        return violation(
                            Category::Credit,
                            Some(id),
                            "grant on a plane without data",
                        )
                    }
                    Some(receiver) if receiver != dir => {
                        return violation(
                            Category::Direction,
                            Some(id),
                            "grant from the data sender",
                        )
                    }
                    _ => {}
                }
                req.credit += grant;
                if req.credit > req.rev.max_outstanding_credit {
                    return violation(
                        Category::Credit,
                        Some(id),
                        "outstanding credit above revision max",
                    );
                }
                Ok(())
            }
            Control::Paused { paused } => {
                match req.data_direction() {
                    None => {
                        return violation(
                            Category::Credit,
                            Some(id),
                            "paused on a plane without data",
                        )
                    }
                    Some(sender) if sender != dir => {
                        return violation(
                            Category::Direction,
                            Some(id),
                            "paused from the data receiver",
                        )
                    }
                    _ => {}
                }
                if paused == req.paused {
                    return violation(
                        Category::Credit,
                        Some(id),
                        "paused repeats the current state",
                    );
                }
                req.paused = paused;
                Ok(())
            }
        }
    }

    fn frame(&mut self, dir: Dir, frame: &Value) -> Result<(), Outcome> {
        let bytes = frame_bytes(frame);
        let header = check_frame_fixture(frame, &bytes);
        let (_, payload) = match FrameHeader::decode(&bytes) {
            Ok(ok) => ok,
            // Connection-level: the header is untrusted, no request is hit.
            Err(FrameError::Violation) => {
                return violation(Category::Malformed, None, "bad frame header")
            }
            Err(FrameError::ShortHeader) => return Err(Outcome::Ignored),
        };
        let id = header.request_id;
        let target = Some(id);
        if !self.live(id, dir) {
            return Err(Outcome::Ignored);
        }
        let req = self.requests.get_mut(&id).unwrap();
        if !req.rev.data.is_binary() || req.data_direction() != Some(dir) {
            return violation(
                Category::Direction,
                target,
                "frame against the data direction",
            );
        }
        if payload.is_empty() {
            return violation(Category::Blob, target, "zero-length frame");
        }
        if payload.len() > MAX_BULK_CHUNK_BYTES {
            return violation(Category::Blob, target, "chunk above 64 KiB");
        }
        let overflow = req.rev.overflow;
        let max_item = req.rev.max_item_bytes;
        if req.paused {
            return violation(
                Category::Credit,
                target,
                "data while the sender reported paused",
            );
        }
        let credit = req.credit;
        let Some(channel) = req.channels.get_mut(&header.channel) else {
            return violation(Category::Blob, target, "bytes on an unannounced channel");
        };
        if !channel.seq.accept(overflow, header.seq) {
            return violation(
                Category::Sequence,
                target,
                format!("seq {} rejected", header.seq),
            );
        }
        let len = payload.len() as u64;
        if len > credit {
            return violation(Category::Credit, target, "data beyond granted credit");
        }
        let total = channel.received.len() as u64 + len;
        if channel.declared.is_some_and(|d| total > d) {
            return violation(Category::Blob, target, "bytes beyond the declaration");
        }
        if total > max_item {
            return violation(Category::Blob, target, "item above maxItemBytes");
        }
        channel.received.extend_from_slice(payload);
        req.credit -= len;
        req.data_seen = true;
        Ok(())
    }

    /// The step after a request-level violation must be exactly its reaction.
    fn reaction(&mut self, dir: Dir, step: &Value, expect: Expect) {
        let message = step.get("message").expect("a reaction is a message step");
        let text = serde_json::to_string(message).unwrap();
        let msg = DeviceMessage::decode(&text).expect("reaction decodes");
        assert!(self.schemas.envelope.is_valid(message));
        match (expect, msg) {
            (Expect::ClientTerminal { id, code }, DeviceMessage::DeviceResponse(r)) => {
                assert_eq!(dir, Dir::C2s, "a client reaction is c2s");
                assert_eq!(r.id, id, "reaction id");
                assert_eq!(r.error.map(|e| e.code), Some(code), "reaction error code");
                self.retire(id);
            }
            (Expect::ServerCancel { id }, DeviceMessage::DeviceEvent(e)) => {
                assert_eq!(dir, Dir::S2c, "a server reaction is s2c");
                assert_eq!(e.id, id, "reaction id");
                assert_eq!(
                    e.control,
                    Some(Control::Cancel { cancel: true }),
                    "reaction is a cancel"
                );
                self.retire(id);
            }
            (expect, other) => panic!("expected reaction {expect:?}, got {other:?}"),
        }
    }
}

/// Header fields in the fixture must agree with the golden bytes (no lossy
/// casts: an out-of-range field is a fixture error).
fn check_frame_fixture(frame: &Value, bytes: &[u8]) -> FrameHeader {
    let h = &frame["header"];
    let field = |k: &str| h[k].as_u64().unwrap_or_else(|| panic!("header.{k}"));
    let expected = FrameHeader {
        version: u8::try_from(field("version")).expect("version fits u8"),
        flags: u8::try_from(field("flags")).expect("flags fits u8"),
        channel: u16::try_from(field("channel")).expect("channel fits u16"),
        request_id: u32::try_from(field("requestId")).expect("requestId fits u32"),
        seq: u32::try_from(field("seq")).expect("seq fits u32"),
    };
    assert!(
        bytes.len() >= FRAME_HEADER_LEN,
        "frame shorter than a header"
    );
    assert_eq!(
        &bytes[..FRAME_HEADER_LEN],
        expected.encode(),
        "header fields must reproduce the golden bytes"
    );
    if let Some(payload_hex) = frame.get("payloadHex").and_then(Value::as_str) {
        assert_eq!(
            &bytes[FRAME_HEADER_LEN..],
            hex_decode(payload_hex),
            "payload mismatch"
        );
    }
    expected
}

/// Terminal success: the exact announced item set with actual byte counts
/// and hashes (uploads; a declared size must also match), or the declared
/// download size and hash (downloads).
fn verify_terminal(req: &Request, id: u32, result: &Value) -> Result<(), Outcome> {
    let target = Some(id);
    match req.rev.data {
        DataPlane::BinaryUpload => {
            let items: Vec<&Value> = match result.get("items") {
                Some(items) => items.as_array().unwrap().iter().collect(),
                None => vec![&result["item"]],
            };
            let reported: BTreeSet<u16> = items
                .iter()
                .map(|i| i["channel"].as_u64().unwrap() as u16)
                .collect();
            let announced: BTreeSet<u16> = req.channels.keys().copied().collect();
            if reported != announced || reported.len() != items.len() {
                return violation(
                    Category::Blob,
                    target,
                    "result item set differs from announcements",
                );
            }
            for item in items {
                let ch = &req.channels[&(item["channel"].as_u64().unwrap() as u16)];
                if item["contentType"] != Value::String(ch.content_type.clone()) {
                    return violation(Category::Blob, target, "contentType differs from blobStart");
                }
                let bytes = item["bytes"].as_u64().unwrap();
                let received = ch.received.len() as u64;
                if bytes != received || ch.declared.is_some_and(|d| d != received) {
                    return violation(
                        Category::Blob,
                        target,
                        "byte count differs from received/declaration",
                    );
                }
                if item["sha256"].as_str().unwrap() != sha256_hex(&ch.received) {
                    return violation(Category::Blob, target, "sha256 mismatch");
                }
            }
            Ok(())
        }
        DataPlane::BinaryDownload => {
            let ch = &req.channels[&0];
            let written = result["bytesWritten"].as_u64().unwrap();
            let received = ch.received.len() as u64;
            if Some(received) != ch.declared || Some(written) != ch.declared {
                return violation(
                    Category::Blob,
                    target,
                    "success before the declared bytes arrived",
                );
            }
            if req.params["sha256"].as_str().unwrap() != sha256_hex(&ch.received) {
                return violation(
                    Category::Blob,
                    target,
                    "received bytes do not match declared sha256",
                );
            }
            Ok(())
        }
        DataPlane::None | DataPlane::JsonEvents => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Counts {
    applied: usize,
    ignored: usize,
    violations: usize,
    reactions: usize,
    frames: usize,
    handshakes: usize,
    transcripts: usize,
    categories: BTreeSet<String>,
    /// Capabilities with a verified success terminal in a positive transcript.
    succeeded: BTreeSet<String>,
    /// Capabilities requested (and admitted) in a positive transcript.
    requested: BTreeSet<String>,
}

fn run_selection_fixture(name: &str, doc: &Value) {
    // A hello that fails handshake-v1 disables device access (D7): decode
    // structurally here; select_device_ack validates it first.
    let hello: DeviceHello = serde_json::from_value(doc["hello"].clone()).unwrap();
    let strict = DeviceHello::from_value(&doc["hello"]).is_ok();
    let server_versions: Vec<u32> =
        serde_json::from_value(doc["serverProtocolVersions"].clone()).unwrap();
    let server_caps: Vec<CapabilityOffer> =
        serde_json::from_value(doc["serverCapabilities"].clone()).unwrap();
    let server_binary = doc["serverBinary"].as_bool().unwrap();
    let ack = select_device_ack(&hello, &server_versions, &server_caps, server_binary);
    if !strict {
        assert!(
            ack.is_none(),
            "{name}: an invalid hello must disable device access"
        );
    }
    match &doc["expectAck"] {
        Value::Null => assert!(ack.is_none(), "{name}: expected device disabled"),
        expected_raw => {
            let expected = DeviceAck::from_value(expected_raw).expect("expectAck is valid");
            assert_eq!(ack, Some(expected), "{name}: selection mismatch");
        }
    }
}

/// Replays one wire transcript. Returns the number of violations detected.
fn run_transcript(schemas: &Schemas, name: &str, doc: &Value, counts: &mut Counts) -> usize {
    let steps = doc["steps"].as_array().unwrap();
    let mut conn = Conn::new(schemas, doc);
    let mut awaiting: Option<Expect> = None;
    let mut violations = 0;
    for (i, step) in steps.iter().enumerate() {
        let at = format!("{name} step {i}");
        let dir = match step["dir"].as_str().unwrap() {
            "s2c" => Dir::S2c,
            _ => Dir::C2s,
        };
        let is_reaction = step.get("reaction").is_some();
        if let Some(expect) = awaiting.take() {
            assert!(
                is_reaction,
                "{at}: the reaction {expect:?} must come next, flagged \"reaction\""
            );
            conn.reaction(dir, step, expect);
            counts.reactions += 1;
            continue;
        }
        assert!(
            !is_reaction,
            "{at}: flagged reaction but no violation precedes it"
        );
        let flagged_ignored = step.get("ignored").is_some();
        let expected = step
            .get("expectViolation")
            .map(|c| Category::parse(c.as_str().unwrap()));
        if step.get("frame").is_some() {
            counts.frames += 1;
        }
        let outcome = conn.step(dir, step);
        match (outcome, expected, flagged_ignored) {
            (Err(Outcome::Violation(v)), Some(want), false) => {
                assert_eq!(
                    v.category, want,
                    "{at}: wrong violation category ({})",
                    v.why
                );
                counts.violations += 1;
                violations += 1;
                counts
                    .categories
                    .insert(step["expectViolation"].as_str().unwrap().to_string());
                match (v.category, v.target) {
                    (Category::Connection, _) => {
                        assert_eq!(i, steps.len() - 1, "{at}: a connection violation closes the device connection: nothing may follow");
                        return violations;
                    }
                    (_, None) => {
                        assert_eq!(
                            v.category,
                            Category::Malformed,
                            "{at}: only malformed is connection-level"
                        );
                    }
                    (category, Some(id)) => {
                        awaiting = match dir {
                            Dir::S2c => Some(Expect::ClientTerminal {
                                id,
                                code: if category == Category::Unsupported {
                                    DeviceErrorCode::Unsupported
                                } else {
                                    DeviceErrorCode::InvalidParams
                                },
                            }),
                            Dir::C2s if v.terminal => {
                                conn.retire(id); // the server settles locally
                                None
                            }
                            Dir::C2s => Some(Expect::ServerCancel { id }),
                        };
                    }
                }
            }
            (Err(Outcome::Violation(v)), _, _) => {
                panic!("{at}: unexpected {:?} violation: {}", v.category, v.why)
            }
            (Err(Outcome::Ignored), None, true) => counts.ignored += 1,
            (Err(Outcome::Ignored), _, false) => {
                panic!("{at}: targets a non-live id and would be dropped; flag it \"ignored\"")
            }
            (Ok(()), None, false) => {
                counts.applied += 1;
                let m = &step["message"];
                if !name.starts_with("violation-") && m["type"] == "deviceRequest" {
                    counts
                        .requested
                        .insert(m["capability"].as_str().unwrap().to_string());
                }
                if !name.starts_with("violation-")
                    && dir == Dir::C2s
                    && m["type"] == "deviceResponse"
                    && m.get("result").is_some()
                {
                    let id = u32::try_from(m["id"].as_u64().unwrap()).unwrap();
                    counts
                        .succeeded
                        .insert(conn.requests[&id].capability.clone());
                }
            }
            (Ok(()), _, true) => panic!("{at}: flagged ignored but the id is live"),
            (other, Some(want), _) => panic!("{at}: expected {want:?} violation, got {other:?}"),
        }
    }
    assert!(
        awaiting.is_none(),
        "{name}: transcript ends before the required reaction"
    );
    violations
}

#[test]
fn transcripts_hold_the_protocol_state_model() {
    let schemas = Schemas::load();
    // HYPEN_DEVICE_TRANSCRIPTS=<dir> replays another directory (e.g. a
    // reviewer's adversarial set); the coverage floors then do not apply.
    let override_dir = std::env::var_os("HYPEN_DEVICE_TRANSCRIPTS").map(PathBuf::from);
    let dir = override_dir
        .clone()
        .unwrap_or_else(|| device_dir().join("fixtures/device/transcripts"));
    let mut counts = Counts::default();

    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort();
    assert!(!entries.is_empty(), "no transcript fixtures found");

    for path in entries {
        let doc = load(&path);
        validate_fixture(&doc).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let name = doc["name"].as_str().unwrap().to_string();
        assert_eq!(
            path.file_stem().unwrap().to_string_lossy(),
            name,
            "fixture name must match its file name"
        );
        if doc.get("hello").is_some() {
            run_selection_fixture(&name, &doc);
            counts.handshakes += 1;
        } else {
            let negative = name.starts_with("violation-");
            let found = run_transcript(&schemas, &name, &doc, &mut counts);
            assert_eq!(
                found > 0,
                negative,
                "{name}: violation-* transcripts (and only those) contain violations"
            );
            counts.transcripts += 1;
        }
    }

    eprintln!(
        "device transcripts: {} wire, {} handshake; steps applied {}, ignored {}, \
         violations {}, reactions {}, frames {}",
        counts.transcripts,
        counts.handshakes,
        counts.applied,
        counts.ignored,
        counts.violations,
        counts.reactions,
        counts.frames
    );
    if override_dir.is_some() {
        return;
    }
    assert!(counts.applied >= 150, "suspiciously few steps applied");
    assert!(counts.ignored >= 30, "stale-id coverage missing");
    assert!(counts.violations >= 90, "negative transcripts missing");
    assert!(counts.reactions >= 68, "violation reactions missing");
    assert!(counts.frames >= 40, "frame steps missing");
    assert!(counts.handshakes >= 4, "handshake fixtures missing");
    assert!(counts.transcripts >= 118);
    // Every registry capability is exercised by a positive transcript, and
    // every unary one completes there with a terminal `result` the runner
    // verified (streams end by cancel or error; a core-stream terminal
    // closes the connection).
    for decl in hypen_engine::serialize::device::registry() {
        assert!(
            counts.requested.contains(decl.name),
            "{}: no positive transcript requests it",
            decl.name
        );
        if decl.revisions.iter().any(|r| r.mode == Mode::Unary) {
            assert!(
                counts.succeeded.contains(decl.name),
                "{}: no positive transcript completes it",
                decl.name
            );
        }
    }
    let all: BTreeSet<String> = CATEGORIES.iter().map(|c| c.to_string()).collect();
    assert_eq!(
        counts.categories, all,
        "every violation category needs a transcript"
    );
}

/// The fixture format is closed and duplicate keys are fixture errors; these
/// are the reviewer's adversarial fixtures that the loader must refuse.
#[test]
fn fixture_format_is_strictly_validated() {
    let req = r#"{"type":"deviceRequest","id":2,"capability":"bluetooth.scan","version":1,"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":30000,"initialCredit":1,"params":{}}"#;
    let doc = |steps: &str| {
        format!(
            r#"{{"name":"x","description":"x","protocol":1,"steps":[{{"dir":"s2c","message":{req}}},{steps}]}}"#
        )
    };
    // Duplicate key inside a step (adv-dup-key-fixture).
    let dup = doc(
        r#"{"dir":"s2c","message":{"type":"deviceEvent","id":2,"control":{"grant":1},"control":{"cancel":true}}}"#,
    );
    assert!(parse_fixture(&dup).unwrap_err().contains("duplicate key"));
    // Misspelled flag (adv-typo-flag).
    let typo = doc(
        r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"expectviolation":"direction"}"#,
    );
    assert!(validate_fixture(&parse_fixture(&typo).unwrap()).is_err());
    // Both message and frame (adv-step-message-and-frame).
    let both = doc(
        r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"frame":{"header":{"version":1,"flags":0,"channel":0,"requestId":2,"seq":0},"hex":"010000000200000000000000"}}"#,
    );
    assert!(validate_fixture(&parse_fixture(&both).unwrap()).is_err());
    // Flags must be true, categories known, top-level keys closed.
    let flag_false = doc(
        r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"ignored":false}"#,
    );
    assert!(validate_fixture(&parse_fixture(&flag_false).unwrap()).is_err());
    let bad_cat = doc(
        r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"expectViolation":"nope"}"#,
    );
    assert!(validate_fixture(&parse_fixture(&bad_cat).unwrap()).is_err());
    let extra = doc(r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}}}"#)
        .replacen(r#""protocol":1"#, r#""protocol":1,"extra":true"#, 1);
    assert!(validate_fixture(&parse_fixture(&extra).unwrap()).is_err());
    let ok = doc(r#"{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}}}"#);
    assert!(validate_fixture(&parse_fixture(&ok).unwrap()).is_ok());
}

#[test]
fn golden_frames_match_reference_codec() {
    let doc = load(&device_dir().join("fixtures/device/frames.json"));
    for frame in doc["frames"].as_array().unwrap() {
        let bytes = hex_decode(frame["hex"].as_str().unwrap());
        let expected = check_frame_fixture(frame, &bytes);
        let (decoded, _) = FrameHeader::decode(&bytes).expect("golden frame decodes");
        assert_eq!(decoded, expected);
    }
    for invalid in doc["invalid"].as_array().unwrap() {
        let bytes = hex_decode(invalid["hex"].as_str().unwrap());
        let reason = invalid["reason"].as_str().unwrap();
        let err = FrameHeader::decode(&bytes).map(|(h, _)| h).unwrap_err();
        match reason {
            "shortHeader" => assert_eq!(err, FrameError::ShortHeader),
            r if r.starts_with("violation") => assert_eq!(err, FrameError::Violation),
            other => panic!("unknown invalid-frame reason {other}"),
        }
    }
}

#[test]
fn frame_sequence_rules() {
    use hypen_engine::serialize::device::Overflow;
    let doc = load(&device_dir().join("fixtures/device/frames.json"));
    let cases = doc["sequences"]["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let overflow = match case["overflow"].as_str().unwrap() {
            "pause" => Overflow::Pause,
            "dropOldest" => Overflow::DropOldest,
            other => panic!("{name}: overflow {other}"),
        };
        let seqs: Vec<u32> = serde_json::from_value(case["seqs"].clone()).unwrap();
        let mut tracker = ChannelSeq::default();
        let accepted: Vec<bool> = seqs.iter().map(|&s| tracker.accept(overflow, s)).collect();
        if case["valid"].as_bool().unwrap() {
            assert!(accepted.iter().all(|&a| a), "{name}: {accepted:?}");
        } else {
            let (last, rest) = accepted.split_last().unwrap();
            assert!(!last && rest.iter().all(|&a| a), "{name}: {accepted:?}");
        }
    }
}
