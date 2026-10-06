//! JavaScript (wasm-bindgen) bindings for the device broker (RFC 001):
//! `WasmDeviceBroker`, `WasmRetainedBytesPool` and the `device*` handshake
//! helpers, for Node/Bun (`@hypen-space/server`) and Cloudflare
//! (`@hypen-space/cf`).
//!
//! The broker is the sans-IO [`crate::device::DeviceBroker`]; this file only
//! converts values. Shapes (config, open spec, outputs, info) are the ones
//! documented in [`super::device_binding`], shared with WASI and UniFFI.
//! JS specifics:
//!
//! - config / open spec / hello / server capabilities accept either a JSON
//!   string or a plain object (serialized with `JSON.stringify`, so
//!   `undefined` members are simply absent);
//! - times and byte counts are JS numbers (non-negative, finite); a
//!   non-finite or negative time throws;
//! - device text is a JS string; frames and bytes are `Uint8Array`s;
//! - `poll()` returns an array of plain objects: the output JSON with
//!   `frame` (sendFrame), `bytes` (data) and `outcome.blobs[i].bytes`
//!   (settled) attached as `Uint8Array`s;
//! - host errors (malformed config/spec, unknown error code) throw an
//!   `Error`; protocol refusals are values (`{error: {code, detail?}}`).

use js_sys::{Array, Reflect, Uint8Array};
use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::device::{
    file_save_params, is_oversize_device_text, sha256_hex, Output, RetainedBytesPool,
};

use super::device_binding as db;

fn to_js(v: &Value) -> JsValue {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

/// A JSON string as-is, anything else through `JSON.stringify`.
fn json_text(v: &JsValue, what: &str) -> Result<String, JsError> {
    if let Some(s) = v.as_string() {
        return Ok(s);
    }
    js_sys::JSON::stringify(v)
        .ok()
        .and_then(|s| s.as_string())
        .ok_or_else(|| JsError::new(&format!("{what}: expected a JSON string or object")))
}

fn ms(v: f64) -> Result<u64, JsError> {
    db::host_number(v, "device broker time (ms)").map_err(|e| JsError::new(&e))
}

/// A host-supplied count (saturating; the broker clamps it to what it
/// actually delivered, see `DeviceBroker::consumed_events`).
fn count(v: f64, what: &str) -> Result<u64, JsError> {
    db::host_number(v, what).map_err(|e| JsError::new(&e))
}

/// A host-supplied count as `usize`, saturating on wasm32 (never truncating).
fn count_usize(v: f64, what: &str) -> Result<usize, JsError> {
    count(v, what).map(db::saturating_usize)
}

fn set(obj: &JsValue, key: &str, value: &JsValue) {
    let _ = Reflect::set(obj, &JsValue::from_str(key), value);
}

fn bytes_js(b: &[u8]) -> JsValue {
    Uint8Array::from(b).into()
}

fn output_to_js(o: Output) -> JsValue {
    match o {
        Output::SendText(text) => to_js(&serde_json::json!({ "type": "sendText", "text": text })),
        Output::SendFrame(frame) => {
            let obj = to_js(&serde_json::json!({ "type": "sendFrame" }));
            set(&obj, "frame", &bytes_js(&frame));
            obj
        }
        Output::Event { id, event } => {
            to_js(&serde_json::json!({ "type": "event", "id": id, "event": event }))
        }
        Output::Data { id, channel, bytes } => {
            let obj = to_js(&serde_json::json!({ "type": "data", "id": id, "channel": channel }));
            set(&obj, "bytes", &bytes_js(&bytes));
            obj
        }
        Output::Settled { id, outcome } => {
            let (outcome, blobs) = db::outcome_parts(outcome);
            let outcome = to_js(&outcome);
            if let Ok(list) = Reflect::get(&outcome, &JsValue::from_str("blobs")) {
                let list: Array = list.unchecked_into();
                for (i, bytes) in blobs.iter().enumerate() {
                    set(&list.get(i as u32), "bytes", &bytes_js(bytes));
                }
            }
            let obj = to_js(&serde_json::json!({ "type": "settled", "id": id }));
            set(&obj, "outcome", &outcome);
            obj
        }
        Output::CloseConnection { code, reason } => {
            to_js(&serde_json::json!({ "type": "closeConnection", "code": code, "reason": reason }))
        }
    }
}

// ---------------------------------------------------------------------------
// WasmRetainedBytesPool
// ---------------------------------------------------------------------------

/// An aggregate retained-bytes budget shared by several brokers (every
/// connection of one process, or of one Durable Object). Pass it to
/// `WasmDeviceBroker.withPool`.
#[wasm_bindgen]
pub struct WasmRetainedBytesPool {
    inner: RetainedBytesPool,
}

#[wasm_bindgen]
impl WasmRetainedBytesPool {
    #[wasm_bindgen(constructor)]
    pub fn new(limit: f64) -> Result<WasmRetainedBytesPool, JsError> {
        Ok(WasmRetainedBytesPool {
            inner: RetainedBytesPool::new(count(limit, "pool limit")?),
        })
    }

    /// The pool's byte limit.
    #[wasm_bindgen(getter)]
    pub fn limit(&self) -> f64 {
        self.inner.limit() as f64
    }

    /// Bytes currently reserved across every broker using this pool.
    #[wasm_bindgen(js_name = inUse)]
    pub fn in_use(&self) -> f64 {
        self.inner.in_use() as f64
    }
}

// ---------------------------------------------------------------------------
// WasmDeviceBroker
// ---------------------------------------------------------------------------

/// The server-side device broker for one device-enabled connection.
///
/// ```js
/// const broker = new WasmDeviceBroker({ ack }, now());
/// const core = broker.start(now());            // {id} | {error}
/// broker.ownerActivated("m1", 1, now());
/// const r = broker.open({ capability: "gallery.pick", params, moduleInstanceId: "m1", activationId: 1 }, now());
/// socket.onmessage = (m) => typeof m.data === "string"
///   ? broker.onText(m.data, now()) : broker.onFrame(new Uint8Array(m.data), now());
/// for (const o of broker.poll()) { ...sendText / sendFrame / event / data / settled / closeConnection... }
/// const next = broker.tick(now());             // schedule the next tick (or undefined)
/// ```
///
/// Freeing the object (`free()`, or the `FinalizationRegistry` reclaiming
/// an unreachable one) closes the broker with `connectionLost` if the host
/// did not, so its retained bytes always return to a shared
/// `WasmRetainedBytesPool` (see `device_binding::OwnedBroker`).
#[wasm_bindgen]
pub struct WasmDeviceBroker {
    inner: db::OwnedBroker,
}

impl WasmDeviceBroker {
    fn build(
        config: &JsValue,
        pool: Option<RetainedBytesPool>,
        now_ms: f64,
    ) -> Result<WasmDeviceBroker, JsError> {
        let text = json_text(config, "device broker config")?;
        let config = db::parse_config(&text, pool).map_err(|e| JsError::new(&e))?;
        Ok(WasmDeviceBroker {
            inner: db::OwnedBroker::new(config, ms(now_ms)?),
        })
    }
}

#[wasm_bindgen]
impl WasmDeviceBroker {
    /// A broker from the configuration (JSON string or object; only `ack`
    /// is required). Throws on a malformed configuration.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue, now_ms: f64) -> Result<WasmDeviceBroker, JsError> {
        Self::build(&config, None, now_ms)
    }

    /// As the constructor, sharing `pool`'s aggregate budget.
    #[wasm_bindgen(js_name = withPool)]
    pub fn with_pool(
        config: JsValue,
        pool: &WasmRetainedBytesPool,
        now_ms: f64,
    ) -> Result<WasmDeviceBroker, JsError> {
        Self::build(&config, Some(pool.inner.clone()), now_ms)
    }

    /// Open the connection-owned `core.capabilities` stream:
    /// `{id}` or `{error: {code, detail?}}`.
    pub fn start(&mut self, now_ms: f64) -> Result<JsValue, JsError> {
        Ok(to_js(&db::open_result_json(self.inner.start(ms(now_ms)?))))
    }

    /// Open a request (spec: JSON string or object); `download` carries
    /// `file.save` bytes. Returns `{id}` or `{error: {code, detail?}}`;
    /// throws on a malformed spec.
    pub fn open(
        &mut self,
        spec: JsValue,
        now_ms: f64,
        download: Option<Vec<u8>>,
    ) -> Result<JsValue, JsError> {
        let text = json_text(&spec, "device open spec")?;
        let spec = db::parse_open_spec(&text, download).map_err(|e| JsError::new(&e))?;
        Ok(to_js(&db::open_result_json(
            self.inner.open(spec, ms(now_ms)?),
        )))
    }

    /// Server-initiated cancel (sends `cancel`, settles `cancelled`).
    pub fn cancel(&mut self, id: u32, now_ms: f64) -> Result<(), JsError> {
        self.inner.cancel(id, ms(now_ms)?);
        Ok(())
    }

    /// Release a held result's retained-bytes charge (idempotent).
    #[wasm_bindgen(js_name = releaseResult)]
    pub fn release_result(&mut self, id: u32) {
        self.inner.release_result(id);
    }

    /// The consumer finished `n` JSON events of stream `id`.
    #[wasm_bindgen(js_name = consumedEvents)]
    pub fn consumed_events(&mut self, id: u32, n: f64, now_ms: f64) -> Result<(), JsError> {
        self.inner
            .consumed_events(id, count(n, "event count")?, ms(now_ms)?);
        Ok(())
    }

    /// The consumer finished the next `chunks` data chunks of stream `id`.
    #[wasm_bindgen(js_name = consumedData)]
    pub fn consumed_data(&mut self, id: u32, chunks: f64, now_ms: f64) -> Result<(), JsError> {
        self.inner
            .consumed_data(id, count_usize(chunks, "chunk count")?, ms(now_ms)?);
        Ok(())
    }

    /// Record a module activation; false for a stale one.
    #[wasm_bindgen(js_name = ownerActivated)]
    pub fn owner_activated(
        &mut self,
        module_instance_id: &str,
        activation_id: u32,
        now_ms: f64,
    ) -> Result<bool, JsError> {
        Ok(self
            .inner
            .owner_activated(module_instance_id, activation_id, ms(now_ms)?))
    }

    /// The activation ended: activation-owned work is cancelled.
    #[wasm_bindgen(js_name = ownerDeactivated)]
    pub fn owner_deactivated(
        &mut self,
        module_instance_id: &str,
        activation_id: u32,
        now_ms: f64,
    ) -> Result<(), JsError> {
        self.inner
            .owner_deactivated(module_instance_id, activation_id, ms(now_ms)?);
        Ok(())
    }

    /// The module instance was destroyed: all of its work is cancelled.
    #[wasm_bindgen(js_name = ownerDestroyed)]
    pub fn owner_destroyed(
        &mut self,
        module_instance_id: &str,
        now_ms: f64,
    ) -> Result<(), JsError> {
        self.inner.owner_destroyed(module_instance_id, ms(now_ms)?);
        Ok(())
    }

    /// Feed one client → server device text message; true when it was for
    /// a live request.
    #[wasm_bindgen(js_name = onText)]
    pub fn on_text(&mut self, text: &str, now_ms: f64) -> Result<bool, JsError> {
        Ok(self.inner.on_text(text, ms(now_ms)?))
    }

    /// Feed one client → server binary frame; true when accepted.
    #[wasm_bindgen(js_name = onFrame)]
    pub fn on_frame(&mut self, frame: &[u8], now_ms: f64) -> Result<bool, JsError> {
        Ok(self.inner.on_frame(frame, ms(now_ms)?))
    }

    /// Count a connection-level violation the host detected itself.
    #[wasm_bindgen(js_name = reportViolation)]
    pub fn report_violation(&mut self, reason: &str, now_ms: f64) -> Result<(), JsError> {
        self.inner.report_connection_violation(reason, ms(now_ms)?);
        Ok(())
    }

    /// Run due timers; the next deadline (absolute ms) or `undefined`.
    pub fn tick(&mut self, now_ms: f64) -> Result<Option<f64>, JsError> {
        Ok(self.inner.tick(ms(now_ms)?).map(|t| t as f64))
    }

    /// The next deadline without running anything, or `undefined`.
    #[wasm_bindgen(js_name = nextDeadline)]
    pub fn next_deadline(&self) -> Option<f64> {
        self.inner.next_deadline().map(|t| t as f64)
    }

    /// Report the transport's buffered (accepted, unwritten) bytes.
    #[wasm_bindgen(js_name = setTransportBuffered)]
    pub fn set_transport_buffered(&mut self, bytes: f64) -> Result<(), JsError> {
        self.inner
            .set_transport_buffered(count_usize(bytes, "buffered bytes")?);
        Ok(())
    }

    /// Drain every output (and at most one bulk turn) as plain objects.
    pub fn poll(&mut self) -> Array {
        self.inner.poll().into_iter().map(output_to_js).collect()
    }

    /// Close the device plane locally with a wire error code
    /// (`"connectionLost"`); throws on an unknown code.
    pub fn close(&mut self, code: &str) -> Result<(), JsError> {
        let code = db::parse_error_code(code).map_err(|e| JsError::new(&e))?;
        self.inner.close(code);
        Ok(())
    }

    /// Planned reopen of `core.capabilities`; the new id or `undefined`.
    #[wasm_bindgen(js_name = reopenCoreCapabilities)]
    pub fn reopen_core_capabilities(&mut self, now_ms: f64) -> Result<Option<u32>, JsError> {
        Ok(self.inner.reopen_core_capabilities(ms(now_ms)?))
    }

    /// A snapshot of the broker state (see `device_binding::info_json`).
    pub fn info(&self) -> JsValue {
        to_js(&db::info_json(&self.inner))
    }

    #[wasm_bindgen(js_name = isLive)]
    pub fn is_live(&self, id: u32) -> bool {
        self.inner.is_live(id)
    }

    #[wasm_bindgen(getter, js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    #[wasm_bindgen(getter, js_name = liveCount)]
    pub fn live_count(&self) -> u32 {
        self.inner.live_count() as u32
    }

    #[wasm_bindgen(getter, js_name = coreStreamId)]
    pub fn core_stream_id(&self) -> Option<u32> {
        self.inner.core_stream_id()
    }

    #[wasm_bindgen(getter, js_name = retainedBytes)]
    pub fn retained_bytes(&self) -> f64 {
        self.inner.retained_bytes() as f64
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.inner.supports(capability)
    }

    #[wasm_bindgen(js_name = selectedVersion)]
    pub fn selected_version(&self, capability: &str) -> Option<u32> {
        self.inner.selected_version(capability)
    }

    #[wasm_bindgen(js_name = outstandingCredit)]
    pub fn outstanding_credit(&self, id: u32) -> Option<f64> {
        self.inner.outstanding_credit(id).map(|c| c as f64)
    }

    #[wasm_bindgen(js_name = outstandingEventCredit)]
    pub fn outstanding_event_credit(&self, id: u32) -> Option<f64> {
        self.inner.outstanding_event_credit(id).map(|c| c as f64)
    }

    #[wasm_bindgen(js_name = hasBackgroundWork)]
    pub fn has_background_work(&self, module_instance_id: &str) -> bool {
        self.inner.has_background_work(module_instance_id)
    }

    #[wasm_bindgen(js_name = admitsBackground)]
    pub fn admits_background(&self, module_instance_id: &str) -> bool {
        self.inner.admits_background(module_instance_id)
    }

    #[wasm_bindgen(js_name = ownerIsActive)]
    pub fn owner_is_active(&self, module_instance_id: &str, activation_id: u32) -> bool {
        self.inner
            .owner_is_active(module_instance_id, activation_id)
    }

    /// The revision this broker enforces for `capability@version` (registry
    /// revision or its configured override, `maxItemBytes` capped by the
    /// broker's), as `{version, mode, data, consent, overflow, lifetimes,
    /// maxItemBytes, maxItems, maxInitialCredit, maxOutstandingCredit,
    /// maxTimeoutMs}`; `null` when it is not a registry revision.
    pub fn revision(&self, capability: &str, version: u32) -> JsValue {
        to_js(&db::revision_json(&self.inner, capability, version))
    }
}

// ---------------------------------------------------------------------------
// Handshake helpers
// ---------------------------------------------------------------------------

/// `hello.device` (JSON string or object) → the `sessionAck.device` object
/// of a broker-backed server, or `null` (device disabled).
#[wasm_bindgen(js_name = deviceNegotiate)]
pub fn device_negotiate(hello: JsValue, binary_route: bool) -> Result<JsValue, JsError> {
    let text = json_text(&hello, "hello.device")?;
    Ok(to_js(&db::negotiate_json(&text, binary_route)))
}

/// The whole server-side handshake for `hello.device` (strict validation —
/// pass the RAW member text when you have it, so duplicate keys and number
/// spellings are judged as sent — then selection): `{ack}` with the
/// `sessionAck.device` object, or `{ack: null, reason}` when the device
/// plane is disabled (reason for the server log). `serverCapabilities`
/// (`[{name, versions}]` or its JSON; `undefined`/`null` = every capability
/// the broker consumes) replaces the default advertisement; a malformed one
/// throws.
#[wasm_bindgen(js_name = deviceHandshake)]
pub fn device_handshake(
    hello: JsValue,
    binary_route: bool,
    server_capabilities: JsValue,
) -> Result<JsValue, JsError> {
    let text = json_text(&hello, "hello.device")?;
    let caps = if server_capabilities.is_undefined() || server_capabilities.is_null() {
        None
    } else {
        Some(json_text(&server_capabilities, "server capabilities")?)
    };
    db::handshake_json(&text, binary_route, caps.as_deref())
        .map(|v| to_js(&v))
        .map_err(|e| JsError::new(&e))
}

/// `select_device_ack` with explicit server lists (`serverProtocolVersions`:
/// a number array or its JSON; `serverCapabilities`: `[{name, versions}]` or
/// its JSON); the ack object or `null`. Throws on malformed server lists.
#[wasm_bindgen(js_name = deviceSelectAck)]
pub fn device_select_ack(
    hello: JsValue,
    server_protocol_versions: JsValue,
    server_capabilities: JsValue,
    server_binary: bool,
) -> Result<JsValue, JsError> {
    let hello = json_text(&hello, "hello.device")?;
    let versions = json_text(&server_protocol_versions, "server protocol versions")?;
    let server_protocol_versions: Vec<u32> = serde_json::from_str(&versions)
        .map_err(|e| JsError::new(&format!("invalid server protocol versions: {e}")))?;
    let caps = json_text(&server_capabilities, "server capabilities")?;
    db::select_ack_json(&hello, &server_protocol_versions, &caps, server_binary)
        .map(|v| to_js(&v))
        .map_err(|e| JsError::new(&e))
}

/// Strictly decode `hello.device`: `{ok: true, value}` or `{ok: false, error}`.
#[wasm_bindgen(js_name = deviceValidateHello)]
pub fn device_validate_hello(hello: JsValue) -> Result<JsValue, JsError> {
    let text = json_text(&hello, "hello.device")?;
    Ok(to_js(&db::validate_hello_json(&text)))
}

/// Strictly decode `sessionAck.device` (same result shape).
#[wasm_bindgen(js_name = deviceValidateAck)]
pub fn device_validate_ack(ack: JsValue) -> Result<JsValue, JsError> {
    let text = json_text(&ack, "sessionAck.device")?;
    Ok(to_js(&db::validate_ack_json(&text)))
}

/// Whether a broker-backed server has a consuming API for a capability
/// revision (an object or JSON string with `mode` and `data`, such as a
/// `WasmDeviceBroker.revision()` answer): unary, or a stream whose data
/// plane flows client to server. Throws when `mode`/`data` is missing or
/// unknown.
#[wasm_bindgen(js_name = deviceServerConsumes)]
pub fn device_server_consumes(revision: JsValue) -> Result<bool, JsError> {
    let text = json_text(&revision, "capability revision")?;
    db::server_consumes_json(&text).map_err(|e| JsError::new(&e))
}

/// What a broker-backed server advertises: `[{name, versions}]`.
#[wasm_bindgen(js_name = deviceServerAdvertisement)]
pub fn device_server_advertisement() -> JsValue {
    to_js(&db::server_advertisement_json())
}

/// Protocol and broker constants.
#[wasm_bindgen(js_name = deviceConstants)]
pub fn device_constants() -> JsValue {
    to_js(&db::constants_json())
}

/// Whether `text` is device text over the size limit (decided without
/// parsing it): report it with `reportViolation` instead of parsing.
#[wasm_bindgen(js_name = deviceIsOversizeText)]
pub fn device_is_oversize_text(text: &str) -> bool {
    is_oversize_device_text(text)
}

/// The `file.save@1` announcement params for `bytes`.
#[wasm_bindgen(js_name = deviceFileSaveParams)]
pub fn device_file_save_params(name: &str, content_type: &str, bytes: &[u8]) -> JsValue {
    to_js(&file_save_params(name, content_type, bytes))
}

/// Lowercase hex SHA-256.
#[wasm_bindgen(js_name = deviceSha256Hex)]
pub fn device_sha256_hex(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}
