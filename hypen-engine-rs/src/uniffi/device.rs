//! UniFFI bindings for the device broker (RFC 001): the `DeviceBroker` and
//! `DeviceRetainedBytesPool` objects plus the `device*` handshake helpers,
//! for the Kotlin SDK (`NativeEngine`) and the Swift server.
//!
//! The broker is the sans-IO [`crate::device::DeviceBroker`]; JSON shapes
//! (config, open spec, info, output payloads) are the ones documented in
//! [`crate::wasm::device_binding`], shared with the JS and WASI surfaces.
//! Outputs are a typed [`DeviceOutput`] enum here (bytes as `Vec<u8>` →
//! Kotlin `ByteArray` / Swift `Data`); JSON payloads (events, results) are
//! JSON strings the host decodes into its own types.
//!
//! The object is internally locked, so it may be shared across threads, but
//! a host should still drive one broker from one serial context (the
//! connection's) — the protocol is ordered.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::device::{
    file_save_params, is_oversize_device_text, sha256_hex, LocalRefusal, Outcome, Output,
    RetainedBytesPool,
};
use crate::wasm::device_binding as db;

/// A host error: malformed configuration, open spec, server list or error
/// code. Protocol refusals are values ([`DeviceOpenResult::Refused`]).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum DeviceBindingError {
    #[error("Invalid device input: {0}")]
    InvalidInput(String),
}

/// One verified upload item of a successful unary result.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DeviceBlob {
    pub channel: u16,
    pub name: Option<String>,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A request's terminal outcome.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum DeviceOutcome {
    /// `result_json` is the client's validated result; `blobs` the verified
    /// upload items in result order (buffered unary uploads).
    Success {
        result_json: String,
        blobs: Vec<DeviceBlob>,
        simulated: bool,
        held: bool,
    },
    /// `code` is the wire error code (`"cancelled"`, `"invalidParams"`…).
    Failure {
        code: String,
        detail: Option<String>,
    },
}

/// Everything the broker asks the host to do, in order.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum DeviceOutput {
    /// Send this device JSON text message.
    SendText { text: String },
    /// Send this binary frame (download bytes), already scheduled.
    SendFrame { frame: Vec<u8> },
    /// A validated JSON stream event; call `consumed_events` when done.
    Event { id: u32, event_json: String },
    /// Upload bytes of a binary-upload stream; call `consumed_data` when done.
    Data {
        id: u32,
        channel: u16,
        bytes: Vec<u8>,
    },
    /// Request `id` ended (exactly once per opened request).
    Settled { id: u32, outcome: DeviceOutcome },
    /// The broker closed the device plane: close the socket with this code.
    CloseConnection { code: u16, reason: String },
}

/// `start` / `open`: the new request id, or a local refusal (nothing sent).
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum DeviceOpenResult {
    Opened {
        id: u32,
    },
    Refused {
        code: String,
        detail: Option<String>,
    },
}

impl From<Result<u32, LocalRefusal>> for DeviceOpenResult {
    fn from(r: Result<u32, LocalRefusal>) -> Self {
        match r {
            Ok(id) => DeviceOpenResult::Opened { id },
            Err(refusal) => DeviceOpenResult::Refused {
                code: db::error_code_str(refusal.code).to_string(),
                detail: refusal.detail,
            },
        }
    }
}

fn convert_outcome(outcome: Outcome) -> DeviceOutcome {
    match outcome {
        Outcome::Ok {
            result,
            blobs,
            simulated,
            held,
        } => DeviceOutcome::Success {
            result_json: result.to_string(),
            blobs: blobs
                .into_iter()
                .map(|b| DeviceBlob {
                    channel: b.channel,
                    name: b.name,
                    content_type: b.content_type,
                    bytes: b.bytes,
                })
                .collect(),
            simulated,
            held,
        },
        Outcome::Err { code, detail } => DeviceOutcome::Failure {
            code: db::error_code_str(code).to_string(),
            detail,
        },
    }
}

fn convert_output(o: Output) -> DeviceOutput {
    match o {
        Output::SendText(text) => DeviceOutput::SendText { text },
        Output::SendFrame(frame) => DeviceOutput::SendFrame { frame },
        Output::Event { id, event } => DeviceOutput::Event {
            id,
            event_json: event.to_string(),
        },
        Output::Data { id, channel, bytes } => DeviceOutput::Data { id, channel, bytes },
        Output::Settled { id, outcome } => DeviceOutput::Settled {
            id,
            outcome: convert_outcome(outcome),
        },
        Output::CloseConnection { code, reason } => DeviceOutput::CloseConnection { code, reason },
    }
}

/// An aggregate retained-bytes budget shared by several brokers.
#[derive(uniffi::Object)]
pub struct DeviceRetainedBytesPool {
    inner: RetainedBytesPool,
}

#[uniffi::export]
impl DeviceRetainedBytesPool {
    #[uniffi::constructor]
    pub fn new(limit: u64) -> Arc<Self> {
        Arc::new(DeviceRetainedBytesPool {
            inner: RetainedBytesPool::new(limit),
        })
    }

    pub fn limit(&self) -> u64 {
        self.inner.limit()
    }

    /// Bytes currently reserved across every broker using this pool.
    pub fn in_use(&self) -> u64 {
        self.inner.in_use()
    }
}

/// The server-side device broker for one device-enabled connection
/// (sans-IO: the host feeds text/frames/time and drains `poll`).
///
/// Releasing the object (its last Kotlin `destroy()`/`close()`, Swift
/// reference or Python reference) closes the broker with `connectionLost`
/// if the host did not, so its retained bytes always return to a shared
/// [`DeviceRetainedBytesPool`] (see `device_binding::OwnedBroker`).
#[derive(uniffi::Object)]
pub struct DeviceBroker {
    inner: Mutex<db::OwnedBroker>,
}

impl DeviceBroker {
    fn b(&self) -> MutexGuard<'_, db::OwnedBroker> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[uniffi::export]
impl DeviceBroker {
    /// A broker from the configuration JSON (only `ack` is required),
    /// optionally sharing `pool`'s aggregate budget.
    #[uniffi::constructor]
    pub fn new(
        config_json: String,
        pool: Option<Arc<DeviceRetainedBytesPool>>,
        now_ms: u64,
    ) -> Result<Arc<Self>, DeviceBindingError> {
        let config = db::parse_config(&config_json, pool.map(|p| p.inner.clone()))
            .map_err(DeviceBindingError::InvalidInput)?;
        Ok(Arc::new(DeviceBroker {
            inner: Mutex::new(db::OwnedBroker::new(config, now_ms)),
        }))
    }

    /// Open the connection-owned `core.capabilities` stream.
    pub fn start(&self, now_ms: u64) -> DeviceOpenResult {
        self.b().start(now_ms).into()
    }

    /// Open a request from the open JSON; `download` carries `file.save`
    /// bytes.
    pub fn open(
        &self,
        spec_json: String,
        download: Option<Vec<u8>>,
        now_ms: u64,
    ) -> Result<DeviceOpenResult, DeviceBindingError> {
        let spec =
            db::parse_open_spec(&spec_json, download).map_err(DeviceBindingError::InvalidInput)?;
        Ok(self.b().open(spec, now_ms).into())
    }

    /// Server-initiated cancel (sends `cancel`, settles `cancelled`).
    pub fn cancel(&self, id: u32, now_ms: u64) {
        self.b().cancel(id, now_ms);
    }

    /// Release a held result's retained-bytes charge (idempotent).
    pub fn release_result(&self, id: u32) {
        self.b().release_result(id);
    }

    /// The consumer finished `n` JSON events of stream `id`.
    pub fn consumed_events(&self, id: u32, n: u64, now_ms: u64) {
        self.b().consumed_events(id, n, now_ms);
    }

    /// The consumer finished the next `chunks` data chunks of stream `id`.
    pub fn consumed_data(&self, id: u32, chunks: u32, now_ms: u64) {
        self.b().consumed_data(id, chunks as usize, now_ms);
    }

    /// Record a module activation; false for a stale one.
    pub fn owner_activated(
        &self,
        module_instance_id: String,
        activation_id: u32,
        now_ms: u64,
    ) -> bool {
        self.b()
            .owner_activated(&module_instance_id, activation_id, now_ms)
    }

    /// The activation ended: activation-owned work is cancelled.
    pub fn owner_deactivated(&self, module_instance_id: String, activation_id: u32, now_ms: u64) {
        self.b()
            .owner_deactivated(&module_instance_id, activation_id, now_ms);
    }

    /// The module instance was destroyed: all of its work is cancelled.
    pub fn owner_destroyed(&self, module_instance_id: String, now_ms: u64) {
        self.b().owner_destroyed(&module_instance_id, now_ms);
    }

    /// Feed one client → server device text message.
    pub fn on_text(&self, text: String, now_ms: u64) -> bool {
        self.b().on_text(&text, now_ms)
    }

    /// Feed one client → server binary frame.
    pub fn on_frame(&self, frame: Vec<u8>, now_ms: u64) -> bool {
        self.b().on_frame(&frame, now_ms)
    }

    /// Count a connection-level violation the host detected itself.
    pub fn report_violation(&self, reason: String, now_ms: u64) {
        self.b().report_connection_violation(&reason, now_ms);
    }

    /// Run due timers; the next deadline (absolute ms), if any.
    pub fn tick(&self, now_ms: u64) -> Option<u64> {
        self.b().tick(now_ms)
    }

    /// The next deadline without running anything.
    pub fn next_deadline(&self) -> Option<u64> {
        self.b().next_deadline()
    }

    /// Report the transport's buffered (accepted, unwritten) bytes.
    pub fn set_transport_buffered(&self, bytes: u64) {
        self.b()
            .set_transport_buffered(bytes.min(usize::MAX as u64) as usize);
    }

    /// Drain every output (and at most one bulk turn).
    pub fn poll(&self) -> Vec<DeviceOutput> {
        self.b().poll().into_iter().map(convert_output).collect()
    }

    /// Close the device plane locally with a wire error code.
    pub fn close(&self, code: String) -> Result<(), DeviceBindingError> {
        let code = db::parse_error_code(&code).map_err(DeviceBindingError::InvalidInput)?;
        self.b().close(code);
        Ok(())
    }

    /// Planned reopen of `core.capabilities`; the new id, if reopened.
    pub fn reopen_core_capabilities(&self, now_ms: u64) -> Option<u32> {
        self.b().reopen_core_capabilities(now_ms)
    }

    /// A JSON snapshot of the broker state (`device_binding::info_json`).
    pub fn info_json(&self) -> String {
        db::info_json(&self.b()).to_string()
    }

    pub fn is_live(&self, id: u32) -> bool {
        self.b().is_live(id)
    }

    pub fn is_closed(&self) -> bool {
        self.b().is_closed()
    }

    pub fn live_count(&self) -> u32 {
        self.b().live_count() as u32
    }

    pub fn core_stream_id(&self) -> Option<u32> {
        self.b().core_stream_id()
    }

    pub fn retained_bytes(&self) -> u64 {
        self.b().retained_bytes()
    }

    pub fn supports(&self, capability: String) -> bool {
        self.b().supports(&capability)
    }

    pub fn selected_version(&self, capability: String) -> Option<u32> {
        self.b().selected_version(&capability)
    }

    pub fn outstanding_credit(&self, id: u32) -> Option<u64> {
        self.b().outstanding_credit(id)
    }

    pub fn outstanding_event_credit(&self, id: u32) -> Option<u64> {
        self.b().outstanding_event_credit(id)
    }

    pub fn has_background_work(&self, module_instance_id: String) -> bool {
        self.b().has_background_work(&module_instance_id)
    }

    pub fn admits_background(&self, module_instance_id: String) -> bool {
        self.b().admits_background(&module_instance_id)
    }

    pub fn owner_is_active(&self, module_instance_id: String, activation_id: u32) -> bool {
        self.b().owner_is_active(&module_instance_id, activation_id)
    }

    /// The revision this broker enforces for `capability@version`
    /// (`device_binding::revision_json`: the registry revision or its
    /// configured override, `maxItemBytes` capped by the broker's) as JSON,
    /// or `None` when it is not a registry revision.
    pub fn revision_json(&self, capability: String, version: u32) -> Option<String> {
        let v = db::revision_json(&self.b(), &capability, version);
        (!v.is_null()).then(|| v.to_string())
    }
}

// ---------------------------------------------------------------------------
// Handshake helpers
// ---------------------------------------------------------------------------

/// `hello.device` JSON → the `sessionAck.device` JSON of a broker-backed
/// server, or `None` (invalid hello or nothing mutual: device disabled).
#[uniffi::export]
pub fn device_negotiate(hello_json: String, binary_route: bool) -> Option<String> {
    let ack = db::negotiate_json(&hello_json, binary_route);
    (!ack.is_null()).then(|| ack.to_string())
}

/// The server-side handshake for a raw `hello.device`: strict validation
/// and selection in one call, with a diagnostic when the plane is disabled.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DeviceHandshake {
    /// The `sessionAck.device` JSON to send, or `None` (ack without device).
    pub ack_json: Option<String>,
    /// Why the device plane is disabled (server log only), when it is.
    pub reason: Option<String>,
}

/// `hello.device` JSON → [`DeviceHandshake`]. `server_capabilities_json`
/// (`[{name, versions}]`) replaces the default advertisement (every
/// capability the broker consumes); a malformed one is an error.
#[uniffi::export]
pub fn device_handshake(
    hello_json: String,
    binary_route: bool,
    server_capabilities_json: Option<String>,
) -> Result<DeviceHandshake, DeviceBindingError> {
    let v = db::handshake_json(
        &hello_json,
        binary_route,
        server_capabilities_json.as_deref(),
    )
    .map_err(DeviceBindingError::InvalidInput)?;
    Ok(DeviceHandshake {
        ack_json: (!v["ack"].is_null()).then(|| v["ack"].to_string()),
        reason: v["reason"].as_str().map(str::to_string),
    })
}

/// `select_device_ack` with explicit server lists (`server_capabilities_json`
/// = `[{name, versions}]`); the ack JSON or `None`.
#[uniffi::export]
pub fn device_select_ack(
    hello_json: String,
    server_protocol_versions: Vec<u32>,
    server_capabilities_json: String,
    server_binary: bool,
) -> Result<Option<String>, DeviceBindingError> {
    let ack = db::select_ack_json(
        &hello_json,
        &server_protocol_versions,
        &server_capabilities_json,
        server_binary,
    )
    .map_err(DeviceBindingError::InvalidInput)?;
    Ok((!ack.is_null()).then(|| ack.to_string()))
}

/// Strictly decode `hello.device`; the normalized JSON, or the reason.
#[uniffi::export]
pub fn device_validate_hello(hello_json: String) -> Result<String, DeviceBindingError> {
    unwrap_validation(db::validate_hello_json(&hello_json))
}

/// Strictly decode `sessionAck.device`; the normalized JSON, or the reason.
#[uniffi::export]
pub fn device_validate_ack(ack_json: String) -> Result<String, DeviceBindingError> {
    unwrap_validation(db::validate_ack_json(&ack_json))
}

fn unwrap_validation(v: serde_json::Value) -> Result<String, DeviceBindingError> {
    if v["ok"] == true {
        Ok(v["value"].to_string())
    } else {
        Err(DeviceBindingError::InvalidInput(
            v["error"].as_str().unwrap_or("invalid").to_string(),
        ))
    }
}

/// What a broker-backed server advertises: `[{name, versions}]` JSON.
#[uniffi::export]
pub fn device_server_advertisement_json() -> String {
    db::server_advertisement_json().to_string()
}

/// Protocol and broker constants JSON.
#[uniffi::export]
pub fn device_constants_json() -> String {
    db::constants_json().to_string()
}

/// Whether `text` is device text over the size limit (decided without
/// parsing): report it with `report_violation` instead of parsing it.
#[uniffi::export]
pub fn device_is_oversize_text(text: String) -> bool {
    is_oversize_device_text(&text)
}

/// The `file.save@1` announcement params JSON for `bytes`.
#[uniffi::export]
pub fn device_file_save_params_json(name: String, content_type: String, bytes: Vec<u8>) -> String {
    file_save_params(&name, &content_type, &bytes).to_string()
}

/// Whether a broker-backed server has a consuming API for a capability
/// revision JSON with `mode` and `data` (e.g. a
/// [`DeviceBroker::revision_json`] answer): unary, or a stream whose data
/// plane flows client to server. A missing or unknown `mode`/`data` is an
/// error.
#[uniffi::export]
pub fn device_server_consumes(revision_json: String) -> Result<bool, DeviceBindingError> {
    db::server_consumes_json(&revision_json).map_err(DeviceBindingError::InvalidInput)
}

/// Lowercase hex SHA-256.
#[uniffi::export]
pub fn device_sha256_hex(bytes: Vec<u8>) -> String {
    sha256_hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::device_binding::tests::{frame, full_ack_json};
    use serde_json::{json, Value};

    fn broker(pool: Option<Arc<DeviceRetainedBytesPool>>) -> Arc<DeviceBroker> {
        let b = DeviceBroker::new(json!({ "ack": full_ack_json() }).to_string(), pool, 0).unwrap();
        assert!(matches!(b.start(0), DeviceOpenResult::Opened { .. }));
        assert!(b.owner_activated("m1".into(), 1, 0));
        b.poll();
        b
    }

    fn opened(r: DeviceOpenResult) -> u32 {
        match r {
            DeviceOpenResult::Opened { id } => id,
            other => panic!("expected an id, got {other:?}"),
        }
    }

    fn settled(out: &[DeviceOutput], id: u32) -> DeviceOutcome {
        out.iter()
            .find_map(|o| match o {
                DeviceOutput::Settled { id: i, outcome } if *i == id => Some(outcome.clone()),
                _ => None,
            })
            .expect("settled")
    }

    #[test]
    fn upload_and_download_through_the_uniffi_object() {
        let b = broker(None);
        let id = opened(
            b.open(
                json!({"capability": "gallery.pick", "params": {"mediaTypes": ["photo"], "maxCount": 1},
                       "moduleInstanceId": "m1", "activationId": 1})
                .to_string(),
                None,
                1,
            )
            .unwrap(),
        );
        let out = b.poll();
        assert!(out
            .iter()
            .any(|o| matches!(o, DeviceOutput::SendText { text }
            if text.contains("gallery.pick"))));
        let photo = vec![3u8; 70_000];
        assert!(b.on_text(
            json!({"type": "deviceEvent", "id": id, "event": {"kind": "blobStart", "channel": 0,
                   "contentType": "image/jpeg"}})
            .to_string(),
            2
        ));
        assert!(b.on_frame(frame(id, 0, 0, &photo[..65536]), 3));
        assert!(b.on_frame(frame(id, 0, 1, &photo[65536..]), 3));
        b.poll();
        assert!(b.on_text(
            json!({"type": "deviceResponse", "id": id, "result": {"items": [{"channel": 0,
                   "contentType": "image/jpeg", "bytes": photo.len(), "sha256": sha256_hex(&photo)}]}})
            .to_string(),
            4
        ));
        match settled(&b.poll(), id) {
            DeviceOutcome::Success {
                blobs, result_json, ..
            } => {
                assert_eq!(blobs.len(), 1);
                assert_eq!(blobs[0].bytes, photo);
                assert_eq!(blobs[0].content_type, "image/jpeg");
                let r: Value = serde_json::from_str(&result_json).unwrap();
                assert_eq!(r["items"][0]["bytes"], photo.len());
            }
            other => panic!("{other:?}"),
        }

        let data = b"saved".to_vec();
        let params =
            device_file_save_params_json("s.txt".into(), "text/plain".into(), data.clone());
        let dl = opened(
            b.open(
                format!(
                    r#"{{"capability":"file.save","params":{params},"moduleInstanceId":"m1","activationId":1}}"#
                ),
                Some(data.clone()),
                5,
            )
            .unwrap(),
        );
        b.poll();
        assert!(b.on_text(
            json!({"type": "deviceEvent", "id": dl, "control": {"grant": 1024}}).to_string(),
            6
        ));
        let mut sent = Vec::new();
        for _ in 0..4 {
            for o in b.poll() {
                if let DeviceOutput::SendFrame { frame } = o {
                    sent.extend_from_slice(&frame[12..]);
                }
            }
        }
        assert_eq!(sent, data);
        assert!(b.on_text(
            json!({"type": "deviceResponse", "id": dl, "result": {"bytesWritten": data.len()}})
                .to_string(),
            7
        ));
        assert!(matches!(
            settled(&b.poll(), dl),
            DeviceOutcome::Success { .. }
        ));
        let info: Value = serde_json::from_str(&b.info_json()).unwrap();
        assert_eq!(info["liveCount"], 1);
        assert_eq!(b.live_count(), 1);
        assert!(b.core_stream_id().is_some());
    }

    fn grants(out: &[DeviceOutput], id: u32) -> Vec<u64> {
        out.iter()
            .filter_map(|o| match o {
                DeviceOutput::SendText { text } => serde_json::from_str::<Value>(text).ok(),
                _ => None,
            })
            .filter(|m| m["id"] == id)
            .filter_map(|m| m["control"]["grant"].as_u64())
            .collect()
    }

    #[test]
    fn host_counts_are_clamped_to_deliveries_through_the_uniffi_object() {
        let b = broker(None);
        let scan = opened(
            b.open(
                json!({"capability": "bluetooth.scan", "moduleInstanceId": "m1",
                       "activationId": 1, "initialCredit": 2})
                .to_string(),
                None,
                0,
            )
            .unwrap(),
        );
        b.poll();
        // Over-reporting before any delivery earns nothing and returns at once.
        b.consumed_events(scan, 10, 1);
        b.consumed_events(scan, u64::MAX, 1);
        assert!(grants(&b.poll(), scan).is_empty());
        assert_eq!(b.outstanding_event_credit(scan), Some(2));
        assert!(b.on_text(
            json!({"type": "deviceEvent", "id": scan,
                   "event": {"device": {"id": "aa:1", "name": "x", "rssi": -40}}})
            .to_string(),
            2
        ));
        assert!(b
            .poll()
            .iter()
            .any(|o| matches!(o, DeviceOutput::Event { id, .. } if *id == scan)));
        b.consumed_events(scan, u64::MAX, 3);
        assert_eq!(grants(&b.poll(), scan), vec![1]);
        b.consumed_events(scan, u64::MAX, 3);
        assert!(grants(&b.poll(), scan).is_empty(), "already reported");

        let mic = opened(
            b.open(
                json!({"capability": "mic.record", "moduleInstanceId": "m1", "activationId": 1,
                       "params": {"sampleRate": 16000, "format": "pcm16"}, "initialCredit": 2048})
                .to_string(),
                None,
                4,
            )
            .unwrap(),
        );
        b.poll();
        b.consumed_data(mic, u32::MAX, 4);
        assert!(grants(&b.poll(), mic).is_empty());
        assert!(b.on_text(
            json!({"type": "deviceEvent", "id": mic, "event": {"kind": "blobStart",
                   "channel": 0, "contentType": "audio/L16"}})
            .to_string(),
            5
        ));
        assert!(b.on_frame(frame(mic, 0, 0, &[3u8; 1024]), 5));
        assert!(b.on_frame(frame(mic, 0, 1, &[3u8; 1024]), 5));
        b.poll();
        b.consumed_data(mic, u32::MAX, 6);
        assert_eq!(grants(&b.poll(), mic), vec![2048]);
        b.consumed_data(mic, u32::MAX, 6);
        assert!(grants(&b.poll(), mic).is_empty());

        // Host times and buffered bytes at the top of the range saturate.
        b.set_transport_buffered(u64::MAX);
        b.tick(u64::MAX);
        b.consumed_events(scan, u64::MAX, u64::MAX);
        b.poll();
    }

    #[test]
    fn refusals_errors_and_lifecycle() {
        let pool = DeviceRetainedBytesPool::new(1 << 20);
        let b = broker(Some(pool.clone()));
        // Replay firewall: a value, not an error.
        let r = b
            .open(
                json!({"capability": "permission.query", "params": {"permission": "camera"},
                       "moduleInstanceId": "m1", "activationId": 1, "replayed": true})
                .to_string(),
                None,
                0,
            )
            .unwrap();
        assert!(
            matches!(&r, DeviceOpenResult::Refused { code, .. } if code == "unavailable"),
            "{r:?}"
        );
        // Malformed spec / config / code: errors.
        assert!(b.open("{".into(), None, 0).is_err());
        assert!(DeviceBroker::new("{}".into(), None, 0).is_err());
        assert!(b.close("nope".into()).is_err());

        // Activation sweep settles cancelled.
        let id = opened(
            b.open(
                json!({"capability": "permission.request", "params": {"permission": "camera"},
                       "moduleInstanceId": "m1", "activationId": 1})
                .to_string(),
                None,
                1,
            )
            .unwrap(),
        );
        assert!(b.is_live(id));
        assert!(b.owner_is_active("m1".into(), 1));
        b.owner_deactivated("m1".into(), 1, 2);
        assert!(!b.is_live(id));
        assert!(matches!(
            settled(&b.poll(), id),
            DeviceOutcome::Failure { code, .. } if code == "cancelled"
        ));
        assert!(b.supports("gallery.pick".into()));
        assert_eq!(b.selected_version("gallery.pick".into()), Some(1));
        assert!(b.next_deadline().is_some());
        assert!(b.tick(3).is_some());
        b.set_transport_buffered(0);
        b.report_violation("x".into(), 3);
        b.close("connectionLost".into()).unwrap();
        assert!(b.is_closed());
        assert_eq!(pool.in_use(), 0);
        assert_eq!(pool.limit(), 1 << 20);
    }

    /// One upload that declared 50000 bytes and delivered a frame.
    fn reserve_upload(b: &DeviceBroker) {
        let id = opened(
            b.open(
                json!({"capability": "gallery.pick", "params": {"mediaTypes": ["photo"], "maxCount": 1},
                       "moduleInstanceId": "m1", "activationId": 1})
                .to_string(),
                None,
                1,
            )
            .unwrap(),
        );
        b.poll();
        assert!(b.on_text(
            json!({"type": "deviceEvent", "id": id, "event": {"kind": "blobStart", "channel": 0,
                   "contentType": "image/jpeg", "bytes": 50000}})
            .to_string(),
            2
        ));
        assert!(b.on_frame(frame(id, 0, 0, &[1u8; 2000]), 3));
    }

    #[test]
    fn releasing_the_object_without_close_returns_pooled_bytes() {
        let pool = DeviceRetainedBytesPool::new(1 << 30);
        let b = broker(Some(pool.clone()));
        reserve_upload(&b);
        assert_eq!(pool.in_use(), 50000);
        // A second foreign reference (a Kotlin/Swift handle clone) keeps the
        // object — and its reservation — alive.
        let other_ref = Arc::clone(&b);
        drop(b);
        assert_eq!(pool.in_use(), 50000);
        assert!(!other_ref.is_closed());
        // The last reference goes without close(): the bytes come back.
        drop(other_ref);
        assert_eq!(pool.in_use(), 0);

        // Dropping after an explicit close releases nothing twice.
        let keep = broker(Some(pool.clone()));
        reserve_upload(&keep);
        let closed = broker(Some(pool.clone()));
        reserve_upload(&closed);
        assert_eq!(pool.in_use(), 100000);
        closed.close("connectionLost".into()).unwrap();
        assert_eq!(pool.in_use(), 50000);
        drop(closed);
        assert_eq!(pool.in_use(), 50000);
        drop(keep);
        assert_eq!(pool.in_use(), 0);
    }

    #[test]
    fn handshake_helpers() {
        let hello = json!({"protocolVersions": [1], "binary": true, "capabilities": [
            {"name": "core.capabilities", "versions": [1]}, {"name": "file.save", "versions": [1]}]})
        .to_string();
        let ack: Value =
            serde_json::from_str(&device_negotiate(hello.clone(), true).unwrap()).unwrap();
        assert_eq!(ack["capabilities"][1]["name"], "file.save");
        assert_eq!(device_negotiate("{}".into(), true), None);
        let sel = device_select_ack(
            hello.clone(),
            vec![1],
            r#"[{"name":"core.capabilities","versions":[1]}]"#.into(),
            true,
        )
        .unwrap()
        .unwrap();
        assert!(device_validate_ack(sel).is_ok());
        assert!(device_select_ack(hello.clone(), vec![1], "x".into(), true).is_err());
        assert!(device_validate_hello(hello).is_ok());
        assert!(device_validate_hello(
            r#"{"protocolVersions":[0],"binary":true,"capabilities":[]}"#.into()
        )
        .is_err());
        assert!(device_server_advertisement_json().contains("core.capabilities"));
        assert!(device_constants_json().contains("devicePlaneCloseCode"));
        assert!(!device_is_oversize_text("{}".into()));
        assert_eq!(device_sha256_hex(vec![]).len(), 64);
    }

    #[test]
    fn handshake_selects_or_explains_through_uniffi() {
        let hello = json!({"protocolVersions": [1], "binary": true, "capabilities": [
            {"name": "core.capabilities", "versions": [1]}, {"name": "file.save", "versions": [1]}]})
        .to_string();
        let hs = device_handshake(hello.clone(), true, None).unwrap();
        assert_eq!(hs.reason, None);
        assert_eq!(hs.ack_json, device_negotiate(hello.clone(), true));
        let hs = device_handshake(
            r#"{"protocolVersions":[0],"binary":true,"capabilities":[]}"#.into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(hs.ack_json, None);
        assert!(hs.reason.unwrap().starts_with("invalid hello.device: "));
        let hs = device_handshake(
            hello.clone(),
            true,
            Some(r#"[{"name":"file.save","versions":[1]}]"#.into()),
        )
        .unwrap();
        assert!(hs.reason.unwrap().contains("core.capabilities@1"));
        assert!(device_handshake(hello, true, Some("x".into())).is_err());
    }

    #[test]
    fn revision_and_server_consumes() {
        let b = DeviceBroker::new(
            json!({ "ack": full_ack_json(), "maxItemBytes": 4096 }).to_string(),
            None,
            0,
        )
        .unwrap();
        let rev: Value =
            serde_json::from_str(&b.revision_json("mic.record".into(), 1).unwrap()).unwrap();
        assert_eq!(rev["mode"], "stream");
        assert_eq!(rev["data"], "binaryUpload");
        assert_eq!(rev["maxItemBytes"], 4096);
        assert_eq!(b.revision_json("mic.record".into(), 7), None);
        assert_eq!(b.revision_json("nope".into(), 1), None);
        assert!(device_server_consumes(rev.to_string()).unwrap());
        assert!(!device_server_consumes(r#"{"mode":"stream","data":"none"}"#.into()).unwrap());
        assert!(matches!(
            device_server_consumes(r#"{"mode":"unary"}"#.into()),
            Err(DeviceBindingError::InvalidInput(_))
        ));
    }
}
