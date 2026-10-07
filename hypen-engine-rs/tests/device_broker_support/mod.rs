//! Shared harness for the device broker tests (`test_device_broker*.rs`):
//! a started broker on a fake monotonic clock that records every output,
//! keeps the connection-owned `core.capabilities` lease acknowledged (like a
//! live client), and steps time through the broker's own deadlines.
#![allow(dead_code)]

use hypen_engine::device::{BrokerConfig, DeviceBroker, LocalRefusal, OpenSpec, Outcome, Output};
use hypen_engine::serialize::device::{
    registry, CapabilitySelection, DeviceAck, FrameHeader, FRAME_VERSION,
};
use serde_json::{json, Value};

pub const KIB: usize = 1024;
pub const MIB: usize = 1024 * 1024;

/// Every registry capability at revision 1, binary profile.
pub fn full_ack() -> DeviceAck {
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

pub fn config() -> BrokerConfig {
    BrokerConfig::new(full_ack())
}

pub fn frame(id: u32, channel: u16, seq: u32, payload: &[u8]) -> Vec<u8> {
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

pub fn blob_start(id: u32, channel: u16, bytes: Option<u64>, content_type: &str) -> Value {
    let mut event = json!({"kind": "blobStart", "channel": channel, "contentType": content_type});
    if let Some(b) = bytes {
        event["bytes"] = json!(b);
    }
    json!({"type": "deviceEvent", "id": id, "event": event})
}

pub fn item(channel: u16, content_type: &str, bytes: &[u8]) -> Value {
    json!({
        "channel": channel,
        "contentType": content_type,
        "bytes": bytes.len(),
        "sha256": hypen_engine::device::sha256_hex(bytes),
    })
}

pub fn result(id: u32, result: Value) -> Value {
    json!({"type": "deviceResponse", "id": id, "result": result})
}

pub fn error(id: u32, code: &str) -> Value {
    json!({"type": "deviceResponse", "id": id, "error": {"code": code}})
}

pub fn control(id: u32, control: Value) -> Value {
    json!({"type": "deviceEvent", "id": id, "control": control})
}

pub fn event(id: u32, event: Value) -> Value {
    json!({"type": "deviceEvent", "id": id, "event": event})
}

pub fn scan_event(name: &str) -> Value {
    json!({"device": {"id": format!("aa:{name}"), "name": name, "rssi": -40}})
}

pub fn gallery_params(max_count: u64) -> Value {
    json!({"mediaTypes": ["photo"], "maxCount": max_count})
}

pub struct H {
    pub b: DeviceBroker,
    pub now: u64,
    /// Every output with the time it was polled.
    pub log: Vec<(u64, Output)>,
    pub core: u32,
    /// Acknowledge every `core.capabilities` renewal at once.
    pub ack_core: bool,
}

impl H {
    /// A started broker with module `m1` active as activation 1.
    pub fn new() -> H {
        H::with(config())
    }

    pub fn with(config: BrokerConfig) -> H {
        let mut b = DeviceBroker::new(config, 0);
        let core = b.start(0).expect("core.capabilities opens");
        assert!(b.owner_activated("m1", 1, 0));
        let mut h = H {
            b,
            now: 0,
            log: Vec::new(),
            core,
            ack_core: true,
        };
        h.drain();
        h
    }

    /// One poll (one bulk turn), recorded.
    pub fn poll(&mut self) -> Vec<Output> {
        let out = self.b.poll();
        let mut acks = Vec::new();
        for o in &out {
            if let Output::SendText(t) = o {
                let v: Value = serde_json::from_str(t).unwrap();
                if self.ack_core && v["id"] == self.core {
                    if let Some(seq) = v["control"]["renewLease"].as_u64() {
                        acks.push(seq);
                    }
                }
            }
            self.log.push((self.now, o.clone()));
        }
        for seq in acks {
            let core = self.core;
            self.b.on_text(
                &control(core, json!({"leaseAck": seq})).to_string(),
                self.now,
            );
        }
        out
    }

    /// Poll until nothing is left (every bulk turn included).
    pub fn drain(&mut self) -> Vec<Output> {
        let mut all = Vec::new();
        for _ in 0..100_000 {
            let out = self.poll();
            if out.is_empty() {
                break;
            }
            all.extend(out);
        }
        all
    }

    pub fn text(&mut self, v: Value) -> bool {
        let r = self.b.on_text(&v.to_string(), self.now);
        self.drain();
        r
    }

    pub fn raw(&mut self, s: &str) -> bool {
        let r = self.b.on_text(s, self.now);
        self.drain();
        r
    }

    pub fn frame(&mut self, id: u32, channel: u16, seq: u32, payload: &[u8]) -> bool {
        let r = self.b.on_frame(&frame(id, channel, seq, payload), self.now);
        self.drain();
        r
    }

    pub fn open(&mut self, spec: OpenSpec) -> Result<u32, LocalRefusal> {
        let r = self.b.open(spec, self.now);
        self.drain();
        r
    }

    pub fn spec(&self, capability: &str, params: Value) -> OpenSpec {
        OpenSpec::new(capability, params, "m1", 1)
    }

    /// `gallery.pick` (maxCount 16) with `credit` initial upload credit.
    pub fn gallery(&mut self, credit: u64) -> u32 {
        let mut spec = self.spec("gallery.pick", gallery_params(16));
        spec.initial_credit = Some(credit);
        self.open(spec).expect("gallery.pick opens")
    }

    pub fn permission(&mut self) -> u32 {
        let spec = self.spec("permission.request", json!({"permission": "camera"}));
        self.open(spec).expect("permission.request opens")
    }

    pub fn scan(&mut self, credit: u64) -> u32 {
        let mut spec = self.spec("bluetooth.scan", json!({}));
        spec.initial_credit = Some(credit);
        self.open(spec).expect("bluetooth.scan opens")
    }

    pub fn mic(&mut self, credit: u64) -> u32 {
        let mut spec = self.spec(
            "mic.record",
            json!({"sampleRate": 16000, "format": "pcm16"}),
        );
        spec.initial_credit = Some(credit);
        self.open(spec).expect("mic.record opens")
    }

    /// Advance the clock by `ms`, running every broker deadline on the way.
    pub fn advance(&mut self, ms: u64) {
        let target = self.now + ms;
        for _ in 0..1_000_000 {
            match self.b.next_deadline() {
                Some(d) if d <= target => {
                    self.now = self.now.max(d);
                    self.b.tick(self.now);
                    self.drain();
                }
                _ => break,
            }
        }
        self.now = target;
        self.b.tick(target);
        self.drain();
    }

    pub fn texts(&self) -> Vec<Value> {
        self.log
            .iter()
            .filter_map(|(_, o)| match o {
                Output::SendText(t) => Some(serde_json::from_str(t).unwrap()),
                _ => None,
            })
            .collect()
    }

    pub fn controls(&self, id: u32, key: &str) -> Vec<Value> {
        self.texts()
            .into_iter()
            .filter(|m| m["id"] == id && m["control"].get(key).is_some())
            .map(|m| m["control"][key].clone())
            .collect()
    }

    pub fn cancels(&self, id: u32) -> usize {
        self.controls(id, "cancel").len()
    }

    pub fn grants(&self, id: u32) -> Vec<u64> {
        self.controls(id, "grant")
            .into_iter()
            .map(|g| g.as_u64().unwrap())
            .collect()
    }

    /// `(seq, time)` of every renewal sent for `id`.
    pub fn renewals(&self, id: u32) -> Vec<(u64, u64)> {
        self.log
            .iter()
            .filter_map(|(at, o)| match o {
                Output::SendText(t) => {
                    let v: Value = serde_json::from_str(t).unwrap();
                    (v["id"] == id)
                        .then(|| v["control"]["renewLease"].as_u64().map(|s| (s, *at)))
                        .flatten()
                }
                _ => None,
            })
            .collect()
    }

    pub fn requests(&self, capability: &str) -> Vec<Value> {
        self.texts()
            .into_iter()
            .filter(|m| m["type"] == "deviceRequest" && m["capability"] == capability)
            .collect()
    }

    pub fn settled(&self, id: u32) -> Option<&Outcome> {
        self.log.iter().find_map(|(_, o)| match o {
            Output::Settled { id: i, outcome } if *i == id => Some(outcome),
            _ => None,
        })
    }

    pub fn settle_count(&self, id: u32) -> usize {
        self.log
            .iter()
            .filter(|(_, o)| matches!(o, Output::Settled { id: i, .. } if *i == id))
            .count()
    }

    pub fn code(&self, id: u32) -> Option<hypen_engine::serialize::device::DeviceErrorCode> {
        self.settled(id).and_then(Outcome::code)
    }

    pub fn detail(&self, id: u32) -> String {
        match self.settled(id) {
            Some(Outcome::Err { detail, .. }) => detail.clone().unwrap_or_default(),
            other => panic!("request {id} did not fail: {other:?}"),
        }
    }

    pub fn frames(&self) -> Vec<Vec<u8>> {
        self.log
            .iter()
            .filter_map(|(_, o)| match o {
                Output::SendFrame(f) => Some(f.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn events(&self, id: u32) -> Vec<Value> {
        self.log
            .iter()
            .filter_map(|(_, o)| match o {
                Output::Event { id: i, event } if *i == id => Some(event.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn data(&self, id: u32) -> Vec<Vec<u8>> {
        self.log
            .iter()
            .filter_map(|(_, o)| match o {
                Output::Data { id: i, bytes, .. } if *i == id => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn closed(&self) -> Option<(u16, String)> {
        self.log.iter().find_map(|(_, o)| match o {
            Output::CloseConnection { code, reason } => Some((*code, reason.clone())),
            _ => None,
        })
    }

    /// A capability snapshot on the live core stream.
    pub fn snapshot(&mut self, names: &[&str]) -> bool {
        let caps: Vec<Value> = names
            .iter()
            .map(|n| json!({"name": n, "versions": [1]}))
            .collect();
        let core = self.b.core_stream_id().expect("core live");
        self.text(event(core, json!({"capabilities": caps})))
    }
}

pub fn payload_len(frame: &[u8]) -> usize {
    frame.len() - 12
}

pub fn frame_request_id(frame: &[u8]) -> u32 {
    u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]])
}
