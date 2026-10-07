//! Device capabilities for Rust server modules (RFC 001, the Device
//! Capability Protocol).
//!
//! A handler asks the connected client — a browser with
//! `@hypen-space/device-web`, the iOS / Android renderers, the Hypen desktop
//! renderer — to do device work (pick a file, save a file, capture a photo,
//! record audio, scan Bluetooth) and gets the verified result back:
//!
//! ```rust,ignore
//! use hypen_server::device::{DeviceErrorCode, MediaType};
//!
//! .on_action::<()>("changePhoto", |_state, _, ctx| {
//!     let device = ctx.map(|c| c.device()).unwrap_or_default();
//!     match device.gallery_pick(&[MediaType::Photo], 1) {
//!         // Settles later; `then` applies the result to this module's state
//!         // and ships the patches, exactly like an action would.
//!         Ok(call) => call.then(|state: &mut Profile, res| match res {
//!             Ok(items) => state.avatar_bytes = items[0].bytes.len(),
//!             Err(e) => state.error = e.code_str().to_string(),
//!         }),
//!         // Refused before anything was sent (unsupported, unavailable,
//!         // invalidParams, …): an ordinary value, handled right here.
//!         Err(e) => state.error = e.code_str().to_string(),
//!     }
//! })
//! ```
//!
//! # One broker
//!
//! The protocol state machine is the shared sans-IO
//! [`hypen_engine::device::DeviceBroker`] every server SDK runs (TypeScript
//! and Cloudflare through WASM, Go through WASI, Kotlin and Swift through
//! UniFFI): request ids, owners and sweeps, leases, deadlines, credit, token
//! buckets, upload verification (item set, sizes, SHA-256), downloads, bulk
//! scheduling, the `core.capabilities` stream and every violation reaction.
//! This crate links it directly. What stays here, as in every SDK: the
//! handshake and resume tokens (in [`crate::remote::RemoteSession`]), the
//! socket pump, timers, the replay firewall and this handler API.
//!
//! # On by default
//!
//! A session built for a connection — [`RemoteSession::connect`] with the
//! connection's [`SessionTransport`] — negotiates the device plane for any
//! client whose `hello` offers `device`; there is no enable call. Options
//! (budgets, item caps) live on the server-wide [`DeviceServer`]
//! ([`DeviceServer::configure_device`]; sessions use
//! [`DeviceServer::shared`] unless given one), and the one opt-out is
//! `disable_device()` ([`DeviceServer::disable_device`] for every session,
//! [`RemoteSession::disable_device`] for one connection). Connection
//! admission ([`DeviceServer::admit`]: Origin allowlist / authenticator) is
//! the app's ordinary connection policy, enforced exactly when configured,
//! and not a device prerequisite. Clients whose hello offers no `device`
//! (and sessions built without a transport, e.g. in-process) are UI-only.
//!
//! [`RemoteSession::connect`]: crate::remote::RemoteSession::connect
//! [`RemoteSession::disable_device`]: crate::remote::RemoteSession::disable_device
//!
//! # Results are asynchronous, handlers are not
//!
//! Hypen's Rust handlers are synchronous and run while the session is
//! locked, so a device call never blocks one. [`Device::request`] and the
//! typed helpers return at once: `Err` for a local refusal (nothing was
//! sent), or a [`DeviceCall`] that settles later. Consume it with
//! [`DeviceCall::then`] (apply the result to the owning module's state; the
//! patches ship like an action's), [`DeviceCall::on_settled`] (a plain
//! callback), or [`DeviceCall::wait`] (block — only from a thread that is
//! not running a session handler). A call dropped without a consumer is
//! cancelled: an operation outliving its handler never delivers an orphaned
//! blob (§2.4). Streams ([`DeviceStream`]) deliver events / data in order,
//! replenishing credit as the consumer returns, then one end.
//!
//! # Authority
//!
//! A [`Device`] is scoped to the invocation that obtained it: the module
//! instance and activation that were live, and the dispatch's provenance.
//! Agent (`dispatch_external`) dispatches can never open device work
//! (`unavailable`, `syncActions.replay`), and a request from a stale
//! activation is refused (`unavailable`, `owner-inactive`). With no device
//! plane — it is disabled, the session has no transport, the client
//! advertised no device host, the hello was invalid, or the plane closed — every call fails
//! `unavailable` (`device-disabled`) and [`Device::supports`] is false.

mod plane;
mod server;

use std::fmt;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use hypen_engine::device::{Blob, LocalRefusal, OpenSpec, Outcome};
use serde_json::{json, Value};

use crate::state::State;

pub(crate) use plane::{in_dispatch, DevicePlane, DispatchGuard, StateApplier};
pub use server::{
    Admission, Authenticator, DeviceOptions, DeviceServer, DeviceServerConfig, UpgradeRequest,
    NO_ADMISSION_WARNING,
};

pub use hypen_engine::serialize::device::payloads::{
    BluetoothSelectParams, CameraCaptureParams, CameraFacing, CaptureMode, MediaType, MicFormat,
    MicRecordParams, Permission, PermissionStatus, SelectedBluetoothDevice,
};
pub use hypen_engine::serialize::device::{DeviceErrorCode, Lifetime};

/// Close code of a device plane reset (the client reconnects with a full
/// advertisement, RFC 001 §2.5).
pub const DEVICE_PLANE_CLOSE_CODE: u16 = plane::PLANE_CLOSE_CODE;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The device route of a connection: dedicated text and binary sends,
/// disjoint from the UI message path (RFC 001 §5 "use dedicated
/// sendDevice/sendBinary routes").
///
/// Calls happen with the device plane's lock held: they must be cheap and
/// non-blocking (an unbounded channel into the socket writer) and must never
/// call back into the session. **Ordering:** feed the same ordered writer the
/// session's UI messages go to — the `sessionAck` that selects the plane must
/// reach the client before the first device request.
pub trait DeviceTransport: Send + Sync {
    /// Write one device JSON message as a text frame.
    fn send_text(&self, text: String);
    /// Write one binary device frame.
    fn send_binary(&self, frame: Vec<u8>);
    /// Close the socket (`code` 1012 for a device plane reset).
    fn close(&self, code: u16, reason: &str);
    /// Bytes handed to the socket and not yet written (bulk downloads pause
    /// above 256 KiB, §2.3). `0` when unknown.
    fn buffered_bytes(&self) -> usize {
        0
    }
}

/// The connection a [`RemoteSession`](crate::remote::RemoteSession) is
/// served over: its device route ([`DeviceTransport`]) plus
/// [`send_ui`](Self::send_ui) for UI messages the session produces outside
/// a `handle_message` call (the patches a device result ships when it
/// settles later on the socket reader or the timer thread).
///
/// Hand it to the session when you construct it for a connection
/// ([`RemoteSession::connect`](crate::remote::RemoteSession::connect)); the
/// device plane then needs no other call. The same rules as
/// [`DeviceTransport`] apply: cheap, non-blocking, never re-entering the
/// session, and every method feeding the one ordered writer the session's
/// replies go to.
pub trait SessionTransport: DeviceTransport {
    /// Write one UI protocol message (JSON text frame).
    fn send_ui(&self, message: String);
}

// ---------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------

/// A device operation's failure: an ordinary value (RFC 001 §3, §4).
///
/// `detail` is the client's `platformDetail` or the broker's refusal reason:
/// diagnostic text, untrusted where it came from the client. Portable
/// handlers branch on [`Self::code`] only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceError {
    pub code: DeviceErrorCode,
    pub detail: Option<String>,
}

impl DeviceError {
    pub fn new(code: DeviceErrorCode, detail: impl Into<String>) -> Self {
        DeviceError {
            code,
            detail: Some(detail.into()),
        }
    }

    /// The error with no device plane at all.
    pub fn disabled() -> Self {
        DeviceError::new(DeviceErrorCode::Unavailable, "device-disabled")
    }

    /// The protocol code as its wire name (`"denied"`, `"cancelled"`, …).
    pub fn code_str(&self) -> &'static str {
        code_name(self.code)
    }
}

/// The wire name of a device error code.
pub fn code_name(code: DeviceErrorCode) -> &'static str {
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

impl fmt::Display for DeviceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "device: {} ({d})", self.code_str()),
            None => write!(f, "device: {}", self.code_str()),
        }
    }
}

impl std::error::Error for DeviceError {}

impl From<LocalRefusal> for DeviceError {
    fn from(r: LocalRefusal) -> Self {
        DeviceError {
            code: r.code,
            detail: r.detail,
        }
    }
}

/// A device result.
pub type DeviceResult<T> = Result<T, DeviceError>;

/// A successful, validated device value. Derefs to the value;
/// [`Self::simulated`] marks a result produced by a fake host (RFC 001
/// §1.11).
#[derive(Debug, Clone, PartialEq)]
pub struct Delivered<T> {
    pub value: T,
    pub simulated: bool,
}

impl<T> std::ops::Deref for Delivered<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T> Delivered<T> {
    pub fn into_inner(self) -> T {
        self.value
    }
}

/// A raw result: the client's validated JSON result plus the verified
/// upload items (buffered unary uploads), in result order.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceValue {
    pub result: Value,
    pub blobs: Vec<Blob>,
}

/// One verified uploaded item (`gallery.pick`, `file.pick`,
/// `camera.capture`): size and SHA-256 checked by the broker before a
/// handler sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceBlob {
    pub channel: u16,
    /// The file name, where the capability carries one (`file.pick`).
    pub name: Option<String>,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl From<Blob> for DeviceBlob {
    fn from(b: Blob) -> Self {
        DeviceBlob {
            channel: b.channel,
            name: b.name,
            content_type: b.content_type,
            bytes: b.bytes,
        }
    }
}

/// `file.save` receipt: the bytes the client verified and wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveReceipt {
    pub bytes_written: u64,
}

/// One item of a device stream, in order; `End` is always last.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamItem {
    /// A validated JSON stream event (e.g. a `bluetooth.scan` device).
    Event(Value),
    /// Upload bytes of a binary stream (e.g. `mic.record` PCM16), in order.
    Data { channel: u16, bytes: Vec<u8> },
    /// The stream ended: its verified result, or why it failed.
    End(DeviceResult<Delivered<Value>>),
}

fn outcome_value(outcome: Outcome) -> DeviceResult<Delivered<DeviceValue>> {
    match outcome {
        Outcome::Ok {
            result,
            blobs,
            simulated,
            ..
        } => Ok(Delivered {
            value: DeviceValue { result, blobs },
            simulated,
        }),
        Outcome::Err { code, detail } => Err(DeviceError { code, detail }),
    }
}

fn map_value<T>(
    r: DeviceResult<Delivered<DeviceValue>>,
    f: impl FnOnce(DeviceValue) -> DeviceResult<T>,
) -> DeviceResult<Delivered<T>> {
    let d = r?;
    Ok(Delivered {
        value: f(d.value)?,
        simulated: d.simulated,
    })
}

fn decode<T: serde::de::DeserializeOwned>(v: Value) -> DeviceResult<T> {
    serde_json::from_value(v)
        .map_err(|e| DeviceError::new(DeviceErrorCode::Internal, format!("result decode: {e}")))
}

fn blobs(v: DeviceValue) -> DeviceResult<Vec<DeviceBlob>> {
    Ok(v.blobs.into_iter().map(DeviceBlob::from).collect())
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

/// Who owns device work: a module instance and one of its activations
/// (RFC 001 §2.7). Connection-local, never reassigned.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceOwner {
    pub module_instance_id: String,
    pub activation_id: u32,
}

#[derive(Clone)]
struct Bound {
    plane: Arc<DevicePlane>,
    owner: DeviceOwner,
    /// The owning module's state scope (`""` = primary module).
    scope: String,
    /// Replay firewall: the invocation is not the user's own dispatch.
    replayed: bool,
}

/// Per-request options (all optional).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestOptions {
    /// Exact revision; `None` = the live selection's.
    pub version: Option<u32>,
    /// `None` = the revision's default (`activation`).
    pub lifetime: Option<Lifetime>,
    /// Overall deadline; `None` = 300 s. Always clamped to the revision.
    pub timeout: Option<Duration>,
    /// Initial data credit (client → server data planes); `None` = the
    /// broker default. An explicit zero is refused locally.
    pub initial_credit: Option<u64>,
}

/// A handler's device access. See the [module docs](self).
///
/// Cheap to clone; clones share the invocation's authority.
#[derive(Clone, Default)]
pub struct Device {
    bound: Option<Bound>,
}

impl fmt::Debug for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.bound {
            None => f.write_str("Device(disabled)"),
            Some(b) => f
                .debug_struct("Device")
                .field("owner", &b.owner)
                .field("replayed", &b.replayed)
                .finish(),
        }
    }
}

impl Device {
    /// A device with no plane: every call fails `unavailable`
    /// (`device-disabled`). What in-process modules and UI-only connections
    /// get.
    pub fn disabled() -> Self {
        Device { bound: None }
    }

    pub(crate) fn bound(
        plane: Arc<DevicePlane>,
        owner: DeviceOwner,
        scope: String,
        replayed: bool,
    ) -> Self {
        Device {
            bound: Some(Bound {
                plane,
                owner,
                scope,
                replayed,
            }),
        }
    }

    /// Whether a live device plane backs this handle.
    pub fn is_enabled(&self) -> bool {
        self.bound.as_ref().is_some_and(|b| !b.plane.is_closed())
    }

    /// The owner requests from this handle carry.
    pub fn owner(&self) -> Option<&DeviceOwner> {
        self.bound.as_ref().map(|b| &b.owner)
    }

    /// Negotiated live support for `capability` — not a permission grant.
    pub fn supports(&self, capability: &str) -> bool {
        self.bound
            .as_ref()
            .is_some_and(|b| b.plane.supports(capability))
    }

    /// The live selection's revision of `capability`.
    pub fn selected_version(&self, capability: &str) -> Option<u32> {
        self.bound.as_ref()?.plane.selected_version(capability)
    }

    /// The live selection (`(name, revision)`), following the client's
    /// latest `core.capabilities` snapshot.
    pub fn capabilities(&self) -> Vec<(String, u32)> {
        self.bound
            .as_ref()
            .map(|b| b.plane.selection())
            .unwrap_or_default()
    }

    fn spec(
        &self,
        capability: &str,
        params: Value,
        opts: &RequestOptions,
    ) -> DeviceResult<(Bound, OpenSpec)> {
        let b = self.bound.clone().ok_or_else(DeviceError::disabled)?;
        let mut spec = OpenSpec::new(
            capability,
            params,
            b.owner.module_instance_id.clone(),
            b.owner.activation_id,
        );
        spec.version = opts.version;
        spec.lifetime = opts.lifetime;
        spec.timeout_ms = opts.timeout.map(|d| (d.as_millis() as u64).max(1));
        spec.initial_credit = opts.initial_credit;
        spec.replayed = b.replayed;
        Ok((b, spec))
    }

    fn open_unary<T: Send + 'static>(
        &self,
        mut spec: OpenSpec,
        b: Bound,
        convert: fn(Outcome) -> DeviceResult<Delivered<T>>,
    ) -> DeviceResult<DeviceCall<T>> {
        spec.mode = Some(hypen_engine::serialize::device::Mode::Unary);
        // Completed-but-unconsumed results keep counting toward the
        // connection's retained-bytes quota until the consumer is done
        // (§2.4).
        spec.hold_result = true;
        let id = b.plane.open(spec)?;
        Ok(DeviceCall {
            id,
            plane: b.plane,
            scope: b.scope,
            convert,
            armed: true,
        })
    }

    /// Request a unary capability with raw JSON params (the untyped
    /// variant: the typed helpers below are thin wrappers). Params are
    /// validated against the selected revision by the broker before
    /// anything is sent.
    pub fn request(
        &self,
        capability: &str,
        params: Value,
    ) -> DeviceResult<DeviceCall<DeviceValue>> {
        self.request_with(capability, params, RequestOptions::default())
    }

    /// [`Self::request`] with [`RequestOptions`].
    pub fn request_with(
        &self,
        capability: &str,
        params: Value,
        opts: RequestOptions,
    ) -> DeviceResult<DeviceCall<DeviceValue>> {
        let (b, spec) = self.spec(capability, params, &opts)?;
        self.open_unary(spec, b, outcome_value)
    }

    /// Open a stream (`bluetooth.scan`, `mic.record`, …) with raw params.
    pub fn stream(&self, capability: &str, params: Value) -> DeviceResult<DeviceStream> {
        self.stream_with(capability, params, RequestOptions::default())
    }

    /// [`Self::stream`] with [`RequestOptions`].
    pub fn stream_with(
        &self,
        capability: &str,
        params: Value,
        opts: RequestOptions,
    ) -> DeviceResult<DeviceStream> {
        let (b, mut spec) = self.spec(capability, params, &opts)?;
        spec.mode = Some(hypen_engine::serialize::device::Mode::Stream);
        let id = b.plane.open(spec)?;
        Ok(DeviceStream {
            id,
            plane: b.plane,
            scope: b.scope,
            armed: true,
        })
    }

    /// `gallery.pick`: photos / videos from the user's library.
    pub fn gallery_pick(
        &self,
        media_types: &[MediaType],
        max_count: u16,
    ) -> DeviceResult<DeviceCall<Vec<DeviceBlob>>> {
        let (b, spec) = self.spec(
            "gallery.pick",
            json!({"mediaTypes": media_types, "maxCount": max_count}),
            &RequestOptions::default(),
        )?;
        self.open_unary(spec, b, |o| map_value(outcome_value(o), blobs))
    }

    /// `file.pick`: files of the given HTML-style `accept` types (`.pdf`,
    /// `image/*`; empty = any file), each with its name.
    pub fn file_pick(
        &self,
        accept: &[&str],
        max_count: u16,
    ) -> DeviceResult<DeviceCall<Vec<DeviceBlob>>> {
        let (b, spec) = self.spec(
            "file.pick",
            json!({"accept": accept, "maxCount": max_count}),
            &RequestOptions::default(),
        )?;
        self.open_unary(spec, b, |o| map_value(outcome_value(o), blobs))
    }

    /// `file.save`: hand `bytes` to the user to save as `name`. The client
    /// verifies size and SHA-256 before it reports success.
    pub fn save(
        &self,
        name: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> DeviceResult<DeviceCall<SaveReceipt>> {
        let b = self.bound.clone().ok_or_else(DeviceError::disabled)?;
        let mut spec = OpenSpec::save(
            name,
            content_type,
            bytes,
            b.owner.module_instance_id.clone(),
            b.owner.activation_id,
        );
        spec.replayed = b.replayed;
        self.open_unary(spec, b, |o| {
            map_value(outcome_value(o), |v| {
                let n = v.result.get("bytesWritten").and_then(Value::as_u64);
                n.map(|bytes_written| SaveReceipt { bytes_written })
                    .ok_or_else(|| DeviceError::new(DeviceErrorCode::Internal, "no bytesWritten"))
            })
        })
    }

    /// `camera.capture`: one photo or video through the host's capture UI.
    pub fn camera_capture(
        &self,
        params: CameraCaptureParams,
    ) -> DeviceResult<DeviceCall<DeviceBlob>> {
        let params = serde_json::to_value(params).expect("params serialize");
        let (b, spec) = self.spec("camera.capture", params, &RequestOptions::default())?;
        self.open_unary(spec, b, |o| {
            map_value(outcome_value(o), |v| {
                blobs(v)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| DeviceError::new(DeviceErrorCode::Internal, "no item"))
            })
        })
    }

    /// `bluetooth.select`: one device chosen in the host's chooser
    /// (identity only).
    pub fn bluetooth_select(
        &self,
        params: BluetoothSelectParams,
    ) -> DeviceResult<DeviceCall<SelectedBluetoothDevice>> {
        let params = serde_json::to_value(params).expect("params serialize");
        let (b, spec) = self.spec("bluetooth.select", params, &RequestOptions::default())?;
        self.open_unary(spec, b, |o| {
            map_value(outcome_value(o), |v| {
                decode(v.result.get("device").cloned().unwrap_or(Value::Null))
            })
        })
    }

    /// `permission.query`: a live status snapshot; never prompts.
    pub fn permission_query(
        &self,
        permission: Permission,
    ) -> DeviceResult<DeviceCall<PermissionStatus>> {
        self.permission("permission.query", permission)
    }

    /// `permission.request`: the host / OS prompt for one permission.
    pub fn permission_request(
        &self,
        permission: Permission,
    ) -> DeviceResult<DeviceCall<PermissionStatus>> {
        self.permission("permission.request", permission)
    }

    fn permission(
        &self,
        capability: &str,
        permission: Permission,
    ) -> DeviceResult<DeviceCall<PermissionStatus>> {
        let (b, spec) = self.spec(
            capability,
            json!({"permission": permission}),
            &RequestOptions::default(),
        )?;
        self.open_unary(spec, b, |o| {
            map_value(outcome_value(o), |v| {
                decode(v.result.get("status").cloned().unwrap_or(Value::Null))
            })
        })
    }

    /// `mic.record`: PCM16 chunks as [`StreamItem::Data`], then the verified
    /// result (`{durationMs, item}`).
    pub fn mic_record(&self, params: MicRecordParams) -> DeviceResult<DeviceStream> {
        let params = serde_json::to_value(params).expect("params serialize");
        self.stream("mic.record", params)
    }

    /// `bluetooth.scan`: `{device}` events until cancelled or ended.
    pub fn bluetooth_scan(&self) -> DeviceResult<DeviceStream> {
        self.stream("bluetooth.scan", json!({}))
    }
}

// ---------------------------------------------------------------------------
// Pending operations
// ---------------------------------------------------------------------------

/// An admitted unary request that settles later. Consume it with
/// [`Self::then`], [`Self::on_settled`] or [`Self::wait`]; dropping it
/// unconsumed cancels the request.
#[must_use = "a DeviceCall dropped without a consumer is cancelled"]
pub struct DeviceCall<T> {
    id: u32,
    plane: Arc<DevicePlane>,
    scope: String,
    convert: fn(Outcome) -> DeviceResult<Delivered<T>>,
    armed: bool,
}

impl<T> fmt::Debug for DeviceCall<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceCall").field("id", &self.id).finish()
    }
}

impl<T: Send + 'static> DeviceCall<T> {
    /// The request id on this connection.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// A handle that can cancel this request later (e.g. from another
    /// action).
    pub fn handle(&self) -> DeviceHandle {
        DeviceHandle {
            id: self.id,
            plane: Arc::downgrade(&self.plane),
        }
    }

    fn consume(mut self, f: impl FnOnce(DeviceResult<Delivered<T>>) + Send + 'static) {
        self.armed = false;
        let convert = self.convert;
        let id = self.id;
        let weak = Arc::downgrade(&self.plane);
        let mut f = Some(f);
        self.plane.install(
            id,
            Box::new(move |d| {
                if let plane::Delivery::Settled(outcome) = d {
                    if let Some(f) = f.take() {
                        f(convert(outcome));
                    }
                    // The consumer is done with the bytes: release the
                    // result's retained-bytes charge.
                    if let Some(p) = weak.upgrade() {
                        p.release_result(id);
                    }
                }
            }),
        );
    }

    /// Apply the result to the owning module's state when it settles; the
    /// resulting patches ship exactly as an action's would. `S` is that
    /// module's state type (a mismatch is logged and the result dropped).
    pub fn then<S: State>(
        self,
        f: impl FnOnce(&mut S, DeviceResult<Delivered<T>>) + Send + 'static,
    ) {
        let scope = self.scope.clone();
        let applier = self.plane.applier();
        self.consume(move |result| {
            let Some(applier) = applier else {
                log::warn!("hypen device: no session to apply a device result to");
                return;
            };
            let mut once = Some((f, result));
            let applied = applier.apply(&scope, &mut |state_json: &mut Value| {
                let Some((f, result)) = once.take() else {
                    return;
                };
                match crate::state::decode_state::<S>(state_json) {
                    Ok(mut s) => {
                        f(&mut s, result);
                        match crate::state::encode_state(&s, state_json) {
                            Ok(v) => *state_json = v,
                            Err(e) => log::warn!("hypen device: state encode failed: {e}"),
                        }
                    }
                    Err(e) => log::warn!("hypen device: state type mismatch in then(): {e}"),
                }
            });
            if !applied {
                log::debug!("hypen device: session gone before a device result settled");
            }
        });
    }

    /// Call `f` with the result when it settles (on the thread that
    /// delivers it; not under any session lock).
    pub fn on_settled(self, f: impl FnOnce(DeviceResult<Delivered<T>>) + Send + 'static) {
        self.consume(f);
    }

    /// Block until the result settles. Refused (`unavailable`,
    /// `wait-in-handler`, and the request is cancelled) on a thread that is
    /// running a session handler — the result could never arrive there.
    pub fn wait(self) -> DeviceResult<Delivered<T>> {
        if in_dispatch() {
            self.plane.cancel(self.id);
            let mut me = self;
            me.armed = false;
            return Err(DeviceError::new(
                DeviceErrorCode::Unavailable,
                "wait-in-handler: use then() or on_settled() inside a handler",
            ));
        }
        let (tx, rx) = mpsc::channel();
        self.consume(move |r| {
            let _ = tx.send(r);
        });
        rx.recv().unwrap_or_else(|_| {
            Err(DeviceError::new(
                DeviceErrorCode::ConnectionLost,
                "device plane gone",
            ))
        })
    }

    /// Cancel the request (it settles `cancelled`; nothing is delivered).
    pub fn cancel(mut self) {
        self.armed = false;
        self.plane.cancel(self.id);
    }
}

impl<T> Drop for DeviceCall<T> {
    fn drop(&mut self) {
        if self.armed {
            self.plane.cancel(self.id);
        }
    }
}

/// Cancels a request or stream later (from another handler, a timer, …).
#[derive(Debug, Clone)]
pub struct DeviceHandle {
    id: u32,
    plane: Weak<DevicePlane>,
}

impl DeviceHandle {
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Cancel the operation (a no-op once it ended or the connection went).
    pub fn cancel(&self) {
        if let Some(p) = self.plane.upgrade() {
            p.cancel(self.id);
        }
    }
}

/// An admitted stream. Consume it with [`Self::for_each`] or
/// [`Self::on_item`]; dropping it unconsumed cancels it.
#[must_use = "a DeviceStream dropped without a consumer is cancelled"]
pub struct DeviceStream {
    id: u32,
    plane: Arc<DevicePlane>,
    scope: String,
    armed: bool,
}

impl fmt::Debug for DeviceStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceStream")
            .field("id", &self.id)
            .finish()
    }
}

impl DeviceStream {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn handle(&self) -> DeviceHandle {
        DeviceHandle {
            id: self.id,
            plane: Arc::downgrade(&self.plane),
        }
    }

    /// Call `f` for every item, in order, on the delivering thread; credit
    /// is replenished as `f` returns. Returns a handle to cancel the stream.
    pub fn on_item(mut self, mut f: impl FnMut(StreamItem) + Send + 'static) -> DeviceHandle {
        self.armed = false;
        let handle = self.handle();
        let id = self.id;
        let weak = Arc::downgrade(&self.plane);
        self.plane.install(
            id,
            Box::new(move |d| match d {
                plane::Delivery::Event(e) => {
                    f(StreamItem::Event(e));
                    if let Some(p) = weak.upgrade() {
                        p.consumed_events(id, 1);
                    }
                }
                plane::Delivery::Data { channel, bytes } => {
                    f(StreamItem::Data { channel, bytes });
                    if let Some(p) = weak.upgrade() {
                        p.consumed_data(id, 1);
                    }
                }
                plane::Delivery::Settled(outcome) => {
                    let end = outcome_value(outcome).map(|d| Delivered {
                        value: d.value.result,
                        simulated: d.simulated,
                    });
                    f(StreamItem::End(end));
                }
            }),
        );
        handle
    }

    /// Apply every item to the owning module's state (patches ship like an
    /// action's), in order. Ending the stream always delivers
    /// [`StreamItem::End`], so state never implies a live stream after it
    /// ended (§4).
    pub fn for_each<S: State>(
        self,
        f: impl FnMut(&mut S, StreamItem) + Send + 'static,
    ) -> DeviceHandle {
        let scope = self.scope.clone();
        let applier = self.plane.applier();
        let f = Arc::new(Mutex::new(f));
        self.on_item(move |item| {
            let Some(applier) = &applier else { return };
            let mut item = Some(item);
            let f = Arc::clone(&f);
            applier.apply(&scope, &mut |state_json: &mut Value| {
                let Some(item) = item.take() else { return };
                match crate::state::decode_state::<S>(state_json) {
                    Ok(mut s) => {
                        (f.lock().unwrap())(&mut s, item);
                        if let Ok(v) = crate::state::encode_state(&s, state_json) {
                            *state_json = v;
                        }
                    }
                    Err(e) => log::warn!("hypen device: state type mismatch in for_each(): {e}"),
                }
            });
        })
    }

    /// Cancel the stream.
    pub fn cancel(mut self) {
        self.armed = false;
        self.plane.cancel(self.id);
    }
}

impl Drop for DeviceStream {
    fn drop(&mut self) {
        if self.armed {
            self.plane.cancel(self.id);
        }
    }
}

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

/// What a session's handler closures use to hand out invocation-scoped
/// [`Device`]s: the connection's plane (once negotiated), each module
/// scope's owner, and the current dispatch's provenance.
#[derive(Default)]
pub(crate) struct DeviceBinding {
    plane: Mutex<Option<Arc<DevicePlane>>>,
    owners: Mutex<std::collections::HashMap<String, DeviceOwner>>,
    replayed: std::sync::atomic::AtomicBool,
}

impl DeviceBinding {
    pub(crate) fn attach(
        &self,
        plane: Arc<DevicePlane>,
        owners: std::collections::HashMap<String, DeviceOwner>,
    ) {
        *self.owners.lock().unwrap() = owners;
        *self.plane.lock().unwrap() = Some(plane);
    }

    pub(crate) fn plane(&self) -> Option<Arc<DevicePlane>> {
        self.plane.lock().unwrap().clone()
    }

    pub(crate) fn take_plane(&self) -> Option<Arc<DevicePlane>> {
        self.plane.lock().unwrap().take()
    }

    pub(crate) fn set_replayed(&self, replayed: bool) {
        self.replayed
            .store(replayed, std::sync::atomic::Ordering::SeqCst);
    }

    /// The device for the module whose state lives under `scope`.
    pub(crate) fn device_for(&self, scope: &str) -> Device {
        let Some(plane) = self.plane() else {
            return Device::disabled();
        };
        let Some(owner) = self.owners.lock().unwrap().get(scope).cloned() else {
            return Device::disabled();
        };
        let replayed = self.replayed.load(std::sync::atomic::Ordering::SeqCst);
        Device::bound(plane, owner, scope.to_string(), replayed)
    }

    /// End `scope`'s current activation: its activation-owned work is
    /// cancelled and devices handed out under it are refused
    /// (`owner-inactive`) from now on.
    pub(crate) fn deactivate(&self, scope: &str) {
        let (Some(plane), Some(owner)) = (
            self.plane(),
            self.owners.lock().unwrap().get(scope).cloned(),
        ) else {
            return;
        };
        // Activation 0: never activated (a routed module that was off
        // screen when the plane attached) — nothing to end.
        if owner.activation_id == 0 {
            return;
        }
        plane.owner_deactivated(&owner.module_instance_id, owner.activation_id);
    }

    /// Start a new activation of `scope` (strictly increasing id; the
    /// previous activation's work is swept).
    pub(crate) fn activate(&self, scope: &str) {
        let Some(plane) = self.plane() else { return };
        let mut owners = self.owners.lock().unwrap();
        let Some(owner) = owners.get_mut(scope) else {
            return;
        };
        let next = owner.activation_id.saturating_add(1);
        if plane.owner_activated(&owner.module_instance_id, next) {
            owner.activation_id = next;
        }
    }

    /// `scope`'s module instance was destroyed: all of its work ends and
    /// it can never be activated again.
    pub(crate) fn destroy(&self, scope: &str) {
        let owner = self.owners.lock().unwrap().remove(scope);
        if let (Some(plane), Some(owner)) = (self.plane(), owner) {
            plane.owner_destroyed(&owner.module_instance_id);
        }
    }
}

#[cfg(test)]
mod tests;
