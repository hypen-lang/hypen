//! The desktop capture drivers: `camera.capture`, `mic.record`,
//! `bluetooth.scan`, `bluetooth.select`, `permission.query` and
//! `permission.request` (RFC 001 §2.4, §2.6, §3, §5).
//!
//! Each request is a small state machine owned by
//! [`DesktopDevice`](super::DesktopDevice) on the socket worker. Anything
//! that blocks — opening a camera, starting a microphone, a Bluetooth
//! adapter round trip, an OS permission prompt — runs on its own thread
//! and reports back as a [`CaptureEvent`] through the worker's driver
//! channel, tagged with the socket epoch and request id, so a late answer
//! for a cancelled request is dropped (and whatever hardware handle it
//! carries is released on the spot).
//!
//! User-visible flow (every surface is host UI, see [`super::ui`]):
//!
//! | Capability | Gate | While running | Ends |
//! |---|---|---|---|
//! | `camera.capture` photo | capture panel (live preview, Capture, Cancel) | — | Capture → one `image/jpeg` item (declared size); Cancel → `cancelled` |
//! | `camera.capture` video | capture panel (Record) | the panel shows REC + elapsed + Stop | Stop / `maxDurationMs` / item cap / window hidden → success, one undeclared `video/mp4` item (H.264, no audio track) streamed as encoded; Cancel → `cancelled` (discarded) |
//! | `mic.record` | consent dialog (Continue / Cancel) | recording indicator (origin, elapsed, Stop) | Stop / `maxDurationMs` / item cap / window hidden → success `{durationMs, item}` (`audio/L16`) |
//! | `bluetooth.scan` | consent dialog, remembered 24 h for `wss://` origins (this connection for `ws://`) | scanning indicator (origin, Stop) | Stop → `cancelled` `user-stopped`; window hidden → `cancelled` `indicator-hidden` |
//! | `bluetooth.select` | chooser (live filtered list, Cancel) | — | a row → `{device:{id,name?}}`; Cancel → `cancelled` |
//! | `permission.request` | consent dialog, only when the OS would prompt | — | the OS answer |
//!
//! Consent Cancel is a host refusal (`denied`, 30 s cooldown); Escape on a
//! consent dialog is abandonment (`cancelled`, 3 s cooldown). No hardware
//! → `unavailable` (`no-camera` / `no-microphone` / `no-adapter`); no
//! visible window → `unavailable` (`no-presenter` /
//! `no-activity-indicator`); an OS refusal → `denied` (the permission name).

use std::sync::Arc;
use std::time::{Duration, Instant};

use hypen_engine::serialize::device::{DeviceErrorCode, ProgressState};
use serde_json::{json, Map, Value};

use super::ble::{self, Coalescer};
use super::hw::{
    AudioBlock, Facing, HwError, MicStream, Permission, PermissionState, ScanEvent, ScanHandle,
};
use super::pcm::{self, PcmConverter, PcmFormat};
use super::ui::{
    ActionSink, CameraPhase, CameraPrompt, ChooserEntry, ChooserPrompt, ConsentPrompt,
    IndicatorKind, IndicatorSpec, Surface, SurfaceId, SurfaceUpdate, UiAction,
};
use super::{BlobSource, DesktopDevice, DriverMsg, StartRequest};

/// Captured microphone bytes allowed to wait for credit before the
/// recording ends `throttled` (`capture-buffer-full`), as on the web and
/// Android hosts.
pub const MIC_BUFFER_LIMIT: u64 = 1024 * 1024;
/// The same bound for encoded video.
pub const VIDEO_BUFFER_LIMIT: u64 = 8 * 1024 * 1024;
/// Cooldown after a host refusal (consent Cancel).
pub const DENIAL_COOLDOWN: Duration = Duration::from_secs(30);
/// Cooldown after an abandoned prompt (Escape, capture/chooser Cancel).
pub const DISMISSAL_COOLDOWN: Duration = Duration::from_secs(3);
/// How long a `bluetooth.scan` consent (persistable) is remembered for an
/// authenticated `wss://` origin.
pub const SCAN_GRANT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub const MIC_CONTENT_TYPE: &str = "audio/L16";
pub const PHOTO_CONTENT_TYPE: &str = "image/jpeg";
pub const VIDEO_CONTENT_TYPE: &str = "video/mp4";

/// Host-defined labels (never server text).
pub const MIC_ACTIVITY: &str = "Recording audio from your microphone";
pub const SCAN_ACTIVITY: &str = "Scanning for nearby Bluetooth devices";

/// Something a capture driver's thread, hardware callback or host UI
/// reports back to the worker.
pub(crate) enum CaptureEvent {
    /// A user / window action on the surface with this token.
    Ui(u64, UiAction),
    /// Hardware presence + OS permission, checked off the worker.
    Prechecked {
        hardware: Result<(), HwError>,
        permission: PermissionState,
    },
    /// The OS permission prompt answered.
    PermissionRequested(Result<PermissionState, HwError>),
    CameraOpened,
    CameraFailed(HwError),
    Photo(Result<Vec<u8>, HwError>),
    #[cfg_attr(not(feature = "camera"), allow(dead_code))]
    VideoData(Vec<u8>),
    VideoEnded(Result<(), HwError>),
    MicStarted(Result<Box<dyn MicStream>, HwError>),
    Pcm(Vec<u8>),
    /// The converter reached the recording limit.
    MicLimit,
    MicFailed(HwError),
    ScanStarted(Result<Box<dyn ScanHandle>, HwError>),
    Scan(ScanEvent),
}

impl std::fmt::Debug for CaptureEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureEvent::Ui(t, a) => write!(f, "Ui({t}, {a:?})"),
            CaptureEvent::Prechecked {
                hardware,
                permission,
            } => {
                write!(f, "Prechecked({hardware:?}, {permission:?})")
            }
            CaptureEvent::PermissionRequested(r) => write!(f, "PermissionRequested({r:?})"),
            CaptureEvent::CameraOpened => write!(f, "CameraOpened"),
            CaptureEvent::CameraFailed(e) => write!(f, "CameraFailed({e:?})"),
            CaptureEvent::Photo(r) => write!(f, "Photo({:?})", r.as_ref().map(Vec::len)),
            CaptureEvent::VideoData(b) => write!(f, "VideoData({} B)", b.len()),
            CaptureEvent::VideoEnded(r) => write!(f, "VideoEnded({r:?})"),
            CaptureEvent::MicStarted(r) => write!(f, "MicStarted({:?})", r.as_ref().err()),
            CaptureEvent::Pcm(b) => write!(f, "Pcm({} B)", b.len()),
            CaptureEvent::MicLimit => write!(f, "MicLimit"),
            CaptureEvent::MicFailed(e) => write!(f, "MicFailed({e:?})"),
            CaptureEvent::ScanStarted(r) => write!(f, "ScanStarted({:?})", r.as_ref().err()),
            CaptureEvent::Scan(e) => write!(f, "Scan({e:?})"),
        }
    }
}

/// Sends a [`CaptureEvent`] for one request of one socket.
pub(crate) type Emit = Arc<dyn Fn(CaptureEvent) + Send + Sync>;

/// A shown surface; dropping it removes it from the window.
pub(crate) struct UiGuard {
    ui: Arc<dyn super::ui::DeviceUi>,
    pub(crate) id: SurfaceId,
    pub(crate) token: u64,
}

impl Drop for UiGuard {
    fn drop(&mut self) {
        self.ui.close(self.id);
    }
}

/// A hardware handle bundled with a hold on the host UI that makes it
/// visible. Fields drop in order: the hardware stops first, then the hold
/// is released — so even a handle that arrives after its request ended (and
/// is dropped on arrival) never runs without its indicator on screen.
pub(crate) struct Leased<T> {
    _hardware: T,
    _ui: Arc<UiGuard>,
}

impl MicStream for Leased<Box<dyn MicStream>> {}
impl ScanHandle for Leased<Box<dyn ScanHandle>> {}

/// Whether the request that shared `lease` still holds it (a start thread
/// skips starting hardware for a request that already ended).
pub(crate) fn still_wanted(lease: &Arc<UiGuard>) -> bool {
    Arc::strong_count(lease) > 1
}

/// Commands to a camera thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CamCmd {
    Capture,
    Record,
    Stop,
}

enum CamPhase {
    Prechecking,
    AskingPermission,
    Opening,
    Live,
    Capturing,
    Recording,
    Finishing,
}

pub(crate) struct CameraOp {
    video: bool,
    facing: Option<Facing>,
    max_duration_ms: Option<u64>,
    phase: CamPhase,
    /// Dropping the sender ends the camera thread after its current frame;
    /// the device is released when the thread returns.
    commands: Option<std::sync::mpsc::Sender<CamCmd>>,
    /// Shared with the camera thread: the panel closes only once both the
    /// request and the thread (which releases the camera first) let go, so
    /// the camera is never on without its panel.
    surface: Option<Arc<UiGuard>>,
    channel: Option<u16>,
}

enum MicPhase {
    Prechecking,
    Consent { permission: PermissionState },
    AskingPermission,
    Recording,
    Finished,
}

pub(crate) struct MicOp {
    format: PcmFormat,
    max_bytes: u64,
    phase: MicPhase,
    stream: Option<Box<dyn MicStream>>,
    surface: Option<Arc<UiGuard>>,
    channel: Option<u16>,
    bytes: u64,
}

enum ScanPhase {
    Prechecking,
    Consent { permission: PermissionState },
    AskingPermission,
    Scanning,
}

pub(crate) struct ScanOp {
    phase: ScanPhase,
    handle: Option<Box<dyn ScanHandle>>,
    surface: Option<Arc<UiGuard>>,
    coalescer: Coalescer,
}

enum SelectPhase {
    Prechecking,
    AskingPermission,
    Choosing,
}

pub(crate) struct SelectOp {
    services: Vec<String>,
    prefix: Option<String>,
    phase: SelectPhase,
    handle: Option<Box<dyn ScanHandle>>,
    surface: Option<Arc<UiGuard>>,
    /// Listed devices in first-seen order: rows never move under the
    /// pointer as signal strengths change (a click lands where aimed).
    entries: Vec<ChooserEntry>,
}

enum PermPhase {
    Querying,
    Consent,
    Requesting,
}

pub(crate) struct PermOp {
    permission: Permission,
    request: bool,
    phase: PermPhase,
    surface: Option<Arc<UiGuard>>,
}

pub(crate) enum CaptureOp {
    Camera(CameraOp),
    Mic(MicOp),
    Scan(ScanOp),
    Select(SelectOp),
    Permission(PermOp),
}

/// Capabilities these drivers implement.
pub const CAPTURE_CAPABILITIES: &[&str] = &[
    "camera.capture",
    "mic.record",
    "bluetooth.scan",
    "bluetooth.select",
    "permission.query",
    "permission.request",
];

fn permission_of(params: &Value) -> Option<Permission> {
    serde_json::from_value(params.get("permission")?.clone()).ok()
}

fn spawn_named(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.into()).spawn(f) {
        log::error!("device: cannot spawn {name}: {e}");
    }
}

fn format_duration(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    if s >= 60 {
        format!("{} min {} s", s / 60, s % 60)
    } else {
        format!("{s} s")
    }
}

impl DesktopDevice {
    // ---- plumbing -----------------------------------------------------------

    pub(crate) fn emitter(&self, id: u32) -> Emit {
        let tx = self.tx.clone();
        let epoch = self.epoch;
        Arc::new(move |event| {
            let _ = tx.send(DriverMsg::Capture { epoch, id, event });
        })
    }

    /// Run `f` off the worker; its event comes back through the channel.
    fn off_worker(&self, id: u32, name: &str, f: impl FnOnce() -> CaptureEvent + Send + 'static) {
        let emit = self.emitter(id);
        spawn_named(name, move || emit(f()));
    }

    pub(super) fn show(&mut self, id: u32, surface: Surface) -> Option<UiGuard> {
        self.next_token += 1;
        let token = self.next_token;
        let emit = self.emitter(id);
        let sink: ActionSink = Arc::new(move |a| emit(CaptureEvent::Ui(token, a)));
        let sid = self.ui.show(surface, sink)?;
        Some(UiGuard {
            ui: Arc::clone(&self.ui),
            id: sid,
            token,
        })
    }

    fn cooldown_key(&self, capability: &str) -> (String, String) {
        (self.origin.clone(), capability.to_string())
    }

    pub(super) fn cool_down(&mut self, capability: &str, d: Duration) {
        let key = self.cooldown_key(capability);
        self.cooldowns.insert(key, Instant::now() + d);
    }

    /// Admission for a prompt-raising driver (§5): cooldown, then the host's
    /// single prompt slot (an OS file dialog still on screen counts).
    pub(super) fn admit_prompt(&mut self, id: u32, capability: &str) -> bool {
        let key = self.cooldown_key(capability);
        if self
            .cooldowns
            .get(&key)
            .is_some_and(|until| Instant::now() < *until)
        {
            self.host
                .fail(id, DeviceErrorCode::Throttled, Some("cooldown".into()));
            return false;
        }
        if self.dialog_open.is_some() || !self.host.acquire_prompt(id) {
            self.host.fail(
                id,
                DeviceErrorCode::Throttled,
                Some("another device prompt is open".into()),
            );
            return false;
        }
        true
    }

    fn has_scan_grant(&mut self) -> bool {
        let key = self.cooldown_key("bluetooth.scan");
        if self.connection_grants.contains(&key) {
            return true;
        }
        match self.grants.get(&key) {
            Some(until) if Instant::now() < *until => true,
            Some(_) => {
                self.grants.remove(&key);
                false
            }
            None => false,
        }
    }

    fn remember_scan_grant(&mut self) {
        let key = self.cooldown_key("bluetooth.scan");
        // Persistable grants only for authenticated origins (§5); a ws://
        // grant lives as long as this connection.
        if self.origin.starts_with("wss://") {
            self.grants.insert(key, Instant::now() + SCAN_GRANT_TTL);
        } else {
            self.connection_grants.insert(key);
        }
    }

    fn fail_op(&mut self, id: u32, code: DeviceErrorCode, detail: impl Into<String>) {
        self.captures.remove(&id);
        self.host.fail(id, code, Some(detail.into()));
    }

    /// A modal surface could not be shown: another prompt is up (possibly
    /// from another connection's host in this process — one prompt per
    /// host, §5) → `throttled`; no visible window → `unavailable`.
    fn modal_refused(&mut self, id: u32) {
        if self.ui.can_present() {
            self.fail_op(
                id,
                DeviceErrorCode::Throttled,
                "another device prompt is open",
            );
        } else {
            self.fail_op(id, DeviceErrorCode::Unavailable, "no-presenter");
        }
    }

    fn fail_hw(&mut self, id: u32, e: HwError) {
        let (code, detail) = (e.code(), e.detail());
        self.fail_op(id, code, detail);
    }

    fn permission_state(&self, p: Permission) -> Box<dyn FnOnce() -> PermissionState + Send> {
        match self.hardware.permissions.clone() {
            Some(perms) => Box::new(move || perms.status(p)),
            None => Box::new(|| PermissionState::Granted),
        }
    }

    fn ask_permission(&mut self, id: u32, p: Permission) {
        let perms = self.hardware.permissions.clone();
        self.off_worker(id, "hypen-device-permission", move || {
            CaptureEvent::PermissionRequested(match perms {
                Some(perms) => perms.request(p),
                None => Ok(PermissionState::Granted),
            })
        });
    }

    /// Map a permission state that blocks the operation to its error.
    fn permission_refusal(
        p: Permission,
        state: &PermissionState,
    ) -> Option<(DeviceErrorCode, String)> {
        match state {
            PermissionState::Denied => Some((DeviceErrorCode::Denied, p.as_str().into())),
            PermissionState::NotDeclared => Some((
                DeviceErrorCode::Unavailable,
                format!("not-declared:{}", p.as_str()),
            )),
            PermissionState::Unsupported => Some((
                DeviceErrorCode::Unavailable,
                format!("no-permission-model:{}", p.as_str()),
            )),
            PermissionState::Granted | PermissionState::Prompt => None,
        }
    }

    pub(super) fn display_origin(&self) -> String {
        if self.origin.is_empty() {
            "This app".into()
        } else {
            self.origin.clone()
        }
    }

    // ---- entry points -------------------------------------------------------

    /// Start the driver of an admitted capture request.
    pub(crate) fn start_capture(&mut self, req: StartRequest) {
        let id = req.id;
        match req.capability.as_str() {
            "camera.capture" => self.start_camera(id, &req.params),
            "mic.record" => self.start_mic(id, &req.params),
            "bluetooth.scan" => self.start_scan(id),
            "bluetooth.select" => self.start_select(id, &req.params),
            "permission.query" | "permission.request" => {
                let Some(p) = permission_of(&req.params) else {
                    self.host.fail(
                        id,
                        DeviceErrorCode::InvalidParams,
                        Some("permission".into()),
                    );
                    return;
                };
                let request = req.capability == "permission.request";
                if self.hardware.permissions.is_none() {
                    self.host
                        .fail(id, DeviceErrorCode::Unsupported, Some(p.as_str().into()));
                    return;
                }
                self.captures.insert(
                    id,
                    CaptureOp::Permission(PermOp {
                        permission: p,
                        request,
                        phase: PermPhase::Querying,
                        surface: None,
                    }),
                );
                let status = self.permission_state(p);
                self.off_worker(id, "hypen-device-permission", move || {
                    CaptureEvent::Prechecked {
                        hardware: Ok(()),
                        permission: status(),
                    }
                });
            }
            _ => self.host.fail(id, DeviceErrorCode::Unsupported, None),
        }
    }

    /// The request ended (terminal sent, cancelled, deadline, lease, reset):
    /// close its surfaces and release its hardware now.
    pub(crate) fn stop_capture(&mut self, id: u32) {
        // Field order in every op drops hardware before surfaces.
        self.captures.remove(&id);
    }

    /// A capture event for a live request.
    pub(crate) fn on_capture(&mut self, id: u32, event: CaptureEvent) {
        let kind = match self.captures.get(&id) {
            None => return, // ended meanwhile: handles in `event` drop here
            Some(CaptureOp::Camera(_)) => 0,
            Some(CaptureOp::Mic(_)) => 1,
            Some(CaptureOp::Scan(_)) => 2,
            Some(CaptureOp::Select(_)) => 3,
            Some(CaptureOp::Permission(_)) => 4,
        };
        match kind {
            0 => self.on_camera(id, event),
            1 => self.on_mic(id, event),
            2 => self.on_scan(id, event),
            3 => self.on_select(id, event),
            _ => self.on_permission(id, event),
        }
    }

    // ---- camera.capture -----------------------------------------------------

    fn start_camera(&mut self, id: u32, params: &Value) {
        let Some(backend) = self.hardware.camera.clone() else {
            self.host.fail(id, DeviceErrorCode::Unsupported, None);
            return;
        };
        let video = params.get("mode").and_then(Value::as_str) == Some("video");
        if video && !super::camera::VIDEO_SUPPORTED {
            self.host.fail(
                id,
                DeviceErrorCode::Unsupported,
                Some("no-video-encoder".into()),
            );
            return;
        }
        let facing = match params.get("facing").and_then(Value::as_str) {
            Some("front") => Some(Facing::Front),
            Some("back") => Some(Facing::Back),
            _ => None,
        };
        let max_duration_ms = params.get("maxDurationMs").and_then(Value::as_u64);
        if !self.ui.can_present() {
            self.host.fail(
                id,
                DeviceErrorCode::Unavailable,
                Some("no-presenter".into()),
            );
            return;
        }
        if !self.admit_prompt(id, "camera.capture") {
            return;
        }
        self.host.progress(id, ProgressState::PendingConsent);
        self.captures.insert(
            id,
            CaptureOp::Camera(CameraOp {
                video,
                facing,
                max_duration_ms,
                phase: CamPhase::Prechecking,
                surface: None,
                commands: None,
                channel: None,
            }),
        );
        let status = self.permission_state(Permission::Camera);
        self.off_worker(id, "hypen-device-camera-check", move || {
            let hardware = match backend.camera_count() {
                Ok(0) => Err(HwError::NoDevice("no-camera")),
                Ok(_) => Ok(()),
                Err(e) => Err(e),
            };
            CaptureEvent::Prechecked {
                hardware,
                permission: status(),
            }
        });
    }

    fn camera_op(&mut self, id: u32) -> Option<&mut CameraOp> {
        match self.captures.get_mut(&id) {
            Some(CaptureOp::Camera(op)) => Some(op),
            _ => None,
        }
    }

    fn on_camera(&mut self, id: u32, event: CaptureEvent) {
        match event {
            CaptureEvent::Prechecked {
                hardware,
                permission,
            } => {
                if let Err(e) = hardware {
                    return self.fail_hw(id, e);
                }
                if let Some((code, detail)) =
                    Self::permission_refusal(Permission::Camera, &permission)
                {
                    return self.fail_op(id, code, detail);
                }
                if permission == PermissionState::Prompt {
                    if let Some(op) = self.camera_op(id) {
                        op.phase = CamPhase::AskingPermission;
                    }
                    return self.ask_permission(id, Permission::Camera);
                }
                self.open_camera(id);
            }
            CaptureEvent::PermissionRequested(result) => match result {
                Ok(PermissionState::Granted) => self.open_camera(id),
                Ok(state) => {
                    let (code, detail) = Self::permission_refusal(Permission::Camera, &state)
                        .unwrap_or((DeviceErrorCode::Denied, "camera".into()));
                    self.fail_op(id, code, detail)
                }
                Err(e) => self.fail_hw(id, e),
            },
            CaptureEvent::CameraOpened => {
                let ui = Arc::clone(&self.ui);
                let Some(op) = self.camera_op(id) else { return };
                if matches!(op.phase, CamPhase::Opening) {
                    op.phase = CamPhase::Live;
                    if let Some(s) = &op.surface {
                        ui.update(s.id, SurfaceUpdate::CameraPhase(CameraPhase::Live));
                    }
                }
            }
            CaptureEvent::CameraFailed(e)
            | CaptureEvent::Photo(Err(e))
            | CaptureEvent::VideoEnded(Err(e)) => self.fail_hw(id, e),
            CaptureEvent::Photo(Ok(jpeg)) => {
                // The photo exists: the panel and the camera go away before
                // anything is uploaded.
                if let Some(CaptureOp::Camera(op)) = self.captures.remove(&id) {
                    drop(op);
                }
                self.host.release_prompt(id);
                if jpeg.is_empty() {
                    self.host
                        .fail(id, DeviceErrorCode::Internal, Some("empty-photo".into()));
                    return;
                }
                self.host.progress(id, ProgressState::Running);
                if self
                    .host
                    .open_blob(id, PHOTO_CONTENT_TYPE, Map::new(), BlobSource::Bytes(jpeg))
                    .is_some()
                {
                    self.host.succeed(id, Map::new(), false);
                }
            }
            CaptureEvent::VideoData(bytes) => {
                let Some(channel) = self.camera_op(id).and_then(|op| op.channel) else {
                    return;
                };
                self.host.write_blob(id, channel, bytes);
                if self.host.upload_backlog(id) > VIDEO_BUFFER_LIMIT {
                    self.fail_op(id, DeviceErrorCode::Throttled, "capture-buffer-full");
                }
            }
            CaptureEvent::VideoEnded(Ok(())) => {
                let Some(CaptureOp::Camera(op)) = self.captures.remove(&id) else {
                    return;
                };
                let channel = op.channel;
                drop(op); // the panel closes, the camera is already released
                self.host.release_prompt(id);
                if let Some(ch) = channel {
                    self.host.finish_blob(id, ch);
                    self.host.succeed(id, Map::new(), false);
                }
            }
            CaptureEvent::Ui(token, action) => self.on_camera_ui(id, token, action),
            other => log::debug!("device: camera {id} ignores {other:?}"),
        }
    }

    fn open_camera(&mut self, id: u32) {
        let Some(backend) = self.hardware.camera.clone() else {
            return;
        };
        let origin = self.display_origin();
        let (video, facing, max_duration_ms) = match self.camera_op(id) {
            Some(op) => (op.video, op.facing, op.max_duration_ms),
            None => return,
        };
        let Some(guard) = self.show(
            id,
            Surface::Camera(CameraPrompt {
                origin,
                video,
                max_duration_ms,
            }),
        ) else {
            return self.modal_refused(id);
        };
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let guard = Arc::new(guard);
        let job = super::camera::CameraJob {
            backend,
            facing,
            video,
            max_duration_ms,
            max_bytes: self.item_cap("camera.capture"),
            ui: Arc::clone(&self.ui),
            surface: guard.id,
            panel: Arc::clone(&guard),
            emit: self.emitter(id),
            commands: cmd_rx,
        };
        if let Some(op) = self.camera_op(id) {
            op.surface = Some(guard);
            op.commands = Some(cmd_tx);
            op.phase = CamPhase::Opening;
        }
        spawn_named("hypen-device-camera", move || super::camera::run(job));
    }

    fn item_cap(&self, capability: &str) -> u64 {
        hypen_engine::serialize::device::find_revision(capability, 1)
            .map(|r| r.max_item_bytes)
            .unwrap_or(64 * 1024 * 1024)
    }

    fn on_camera_ui(&mut self, id: u32, token: u64, action: UiAction) {
        let ui = Arc::clone(&self.ui);
        let Some(op) = self.camera_op(id) else { return };
        if op.surface.as_ref().map(|s| s.token) != Some(token) {
            return;
        }
        let sid = op.surface.as_ref().map(|s| s.id).unwrap_or(0);
        let video = op.video;
        enum Next {
            Cancel,
            Capture,
            Record,
            Finish,
            Nothing,
        }
        let next = match (&action, &op.phase) {
            (UiAction::Cancel | UiAction::Dismiss, _) => Next::Cancel,
            (UiAction::Capture, CamPhase::Live) if !video => Next::Capture,
            (UiAction::Record, CamPhase::Live) if video => Next::Record,
            // Stop, or the window disappearing, ends a recording normally.
            (UiAction::Stop | UiAction::Hidden, CamPhase::Recording) => Next::Finish,
            _ => Next::Nothing,
        };
        let send = |op: &CameraOp, cmd: CamCmd| {
            if let Some(tx) = &op.commands {
                let _ = tx.send(cmd);
            }
        };
        match next {
            Next::Nothing => {}
            Next::Cancel => {
                // Dismissing the capture UI is `cancelled`, never a
                // permission denial; a recording in progress is discarded.
                self.cool_down("camera.capture", DISMISSAL_COOLDOWN);
                self.fail_op(id, DeviceErrorCode::Cancelled, "capture-dismissed");
            }
            Next::Capture => {
                op.phase = CamPhase::Capturing;
                send(op, CamCmd::Capture);
                ui.update(
                    sid,
                    SurfaceUpdate::CameraPhase(CameraPhase::Busy("Capturing…".into())),
                );
            }
            Next::Finish => {
                op.phase = CamPhase::Finishing;
                send(op, CamCmd::Stop);
                ui.update(
                    sid,
                    SurfaceUpdate::CameraPhase(CameraPhase::Busy("Finishing…".into())),
                );
            }
            Next::Record => {
                op.phase = CamPhase::Recording;
                send(op, CamCmd::Record);
                ui.update(
                    sid,
                    SurfaceUpdate::CameraPhase(CameraPhase::Recording {
                        since: Instant::now(),
                    }),
                );
                self.host.progress(id, ProgressState::Running);
                // A live recording does not know its size: undeclared (§2.4).
                let channel = self.host.open_blob(
                    id,
                    VIDEO_CONTENT_TYPE,
                    Map::new(),
                    BlobSource::Stream { declared: None },
                );
                match channel {
                    Some(ch) => {
                        if let Some(op) = self.camera_op(id) {
                            op.channel = Some(ch);
                        }
                    }
                    None => {
                        self.captures.remove(&id);
                    }
                }
            }
        }
    }

    // ---- mic.record ---------------------------------------------------------

    fn start_mic(&mut self, id: u32, params: &Value) {
        let Some(backend) = self.hardware.mic.clone() else {
            self.host.fail(id, DeviceErrorCode::Unsupported, None);
            return;
        };
        let rate = params
            .get("sampleRate")
            .and_then(Value::as_u64)
            .unwrap_or(16_000) as u32;
        let channels = params.get("channels").and_then(Value::as_u64).unwrap_or(1) as u16;
        let format = PcmFormat {
            sample_rate: rate,
            channels,
        };
        // A recording never outgrows the item limit: it ends normally
        // there, in whole frames.
        let cap = self.item_cap("mic.record");
        let cap = cap - cap % format.frame_bytes();
        let max_bytes = params
            .get("maxDurationMs")
            .and_then(Value::as_u64)
            .map(|ms| pcm::frames_for(ms, rate) * format.frame_bytes())
            .unwrap_or(cap)
            .min(cap);
        if !self.ui.can_present() {
            self.host.fail(
                id,
                DeviceErrorCode::Unavailable,
                Some("no-presenter".into()),
            );
            return;
        }
        if !self.admit_prompt(id, "mic.record") {
            return;
        }
        self.host.progress(id, ProgressState::PendingConsent);
        self.captures.insert(
            id,
            CaptureOp::Mic(MicOp {
                format,
                max_bytes,
                phase: MicPhase::Prechecking,
                surface: None,
                stream: None,
                channel: None,
                bytes: 0,
            }),
        );
        let status = self.permission_state(Permission::Microphone);
        self.off_worker(id, "hypen-device-mic-check", move || {
            CaptureEvent::Prechecked {
                hardware: if backend.has_input() {
                    Ok(())
                } else {
                    Err(HwError::NoDevice("no-microphone"))
                },
                permission: status(),
            }
        });
    }

    fn mic_op(&mut self, id: u32) -> Option<&mut MicOp> {
        match self.captures.get_mut(&id) {
            Some(CaptureOp::Mic(op)) => Some(op),
            _ => None,
        }
    }

    fn on_mic(&mut self, id: u32, event: CaptureEvent) {
        match event {
            CaptureEvent::Prechecked {
                hardware,
                permission,
            } => {
                if let Err(e) = hardware {
                    return self.fail_hw(id, e);
                }
                if let Some((code, detail)) =
                    Self::permission_refusal(Permission::Microphone, &permission)
                {
                    return self.fail_op(id, code, detail);
                }
                let Some(op) = self.mic_op(id) else { return };
                let format = op.format;
                let max_bytes = op.max_bytes;
                let mut details = vec![format!(
                    "Format: PCM16 · {} Hz · {}",
                    format.sample_rate,
                    if format.channels == 2 {
                        "stereo"
                    } else {
                        "mono"
                    }
                )];
                let max_ms = pcm::duration_ms(max_bytes / format.frame_bytes(), format.sample_rate);
                details.push(format!("Up to {}", format_duration(max_ms)));
                let prompt = ConsentPrompt {
                    origin: self.display_origin(),
                    capability: "mic.record".into(),
                    operation: "record audio from your microphone".into(),
                    details,
                };
                let Some(guard) = self.show(id, Surface::Consent(prompt)) else {
                    return self.modal_refused(id);
                };
                if let Some(op) = self.mic_op(id) {
                    op.surface = Some(Arc::new(guard));
                    op.phase = MicPhase::Consent { permission };
                }
            }
            CaptureEvent::PermissionRequested(result) => match result {
                Ok(PermissionState::Granted) => self.begin_recording(id),
                Ok(state) => {
                    let (code, detail) = Self::permission_refusal(Permission::Microphone, &state)
                        .unwrap_or((DeviceErrorCode::Denied, "microphone".into()));
                    self.fail_op(id, code, detail)
                }
                Err(e) => self.fail_hw(id, e),
            },
            CaptureEvent::Ui(token, action) => self.on_mic_ui(id, token, action),
            CaptureEvent::MicStarted(Ok(stream)) => {
                let Some(op) = self.mic_op(id) else { return };
                if matches!(op.phase, MicPhase::Recording) {
                    op.stream = Some(stream);
                }
                // Finished meanwhile (Stop before the device came up):
                // `stream` drops here and the microphone stops.
            }
            CaptureEvent::MicStarted(Err(e)) | CaptureEvent::MicFailed(e) => {
                let finished = self
                    .mic_op(id)
                    .is_some_and(|op| matches!(op.phase, MicPhase::Finished));
                if !finished {
                    self.fail_hw(id, e);
                }
            }
            CaptureEvent::Pcm(bytes) => {
                let Some(op) = self.mic_op(id) else { return };
                if !matches!(op.phase, MicPhase::Recording) {
                    return;
                }
                let Some(ch) = op.channel else { return };
                let room = op.max_bytes.saturating_sub(op.bytes);
                let take = (bytes.len() as u64).min(room) as usize;
                let take = take - take % op.format.frame_bytes() as usize;
                op.bytes += take as u64;
                let reached = op.bytes >= op.max_bytes;
                let mut bytes = bytes;
                bytes.truncate(take);
                self.host.write_blob(id, ch, bytes);
                if self.host.upload_backlog(id) > MIC_BUFFER_LIMIT {
                    // Starved of credit past the bounded window (§2.4).
                    return self.fail_op(id, DeviceErrorCode::Throttled, "capture-buffer-full");
                }
                if reached {
                    self.finish_recording(id);
                }
            }
            CaptureEvent::MicLimit => self.finish_recording(id),
            other => log::debug!("device: mic {id} ignores {other:?}"),
        }
    }

    fn on_mic_ui(&mut self, id: u32, token: u64, action: UiAction) {
        let Some(op) = self.mic_op(id) else { return };
        if op.surface.as_ref().map(|s| s.token) != Some(token) {
            return;
        }
        match (&op.phase, action) {
            (MicPhase::Consent { .. }, UiAction::Cancel) => {
                self.cool_down("mic.record", DENIAL_COOLDOWN);
                self.fail_op(id, DeviceErrorCode::Denied, "host-refused");
            }
            (MicPhase::Consent { .. }, UiAction::Dismiss) => {
                self.cool_down("mic.record", DISMISSAL_COOLDOWN);
                self.fail_op(id, DeviceErrorCode::Cancelled, "consent-dismissed");
            }
            (MicPhase::Consent { permission }, UiAction::Continue) => {
                let ask = *permission == PermissionState::Prompt;
                op.surface = None; // the dialog closes
                if ask {
                    op.phase = MicPhase::AskingPermission;
                    self.ask_permission(id, Permission::Microphone);
                } else {
                    self.begin_recording(id);
                }
            }
            // Stop is success; so is the indicator becoming invisible
            // (window minimized / closed), like backgrounding on the phones.
            (MicPhase::Recording, UiAction::Stop | UiAction::Hidden) => self.finish_recording(id),
            _ => {}
        }
    }

    /// Consent and permission are settled: the indicator goes up, the
    /// item is announced, and the microphone starts.
    fn begin_recording(&mut self, id: u32) {
        let Some(backend) = self.hardware.mic.clone() else {
            return;
        };
        // The indicator is not a prompt: other prompts may run meanwhile.
        self.host.release_prompt(id);
        let spec = IndicatorSpec {
            origin: self.display_origin(),
            kind: IndicatorKind::Microphone,
            activity: MIC_ACTIVITY.into(),
        };
        let Some(guard) = self.show(id, Surface::Indicator(spec)) else {
            return self.fail_op(id, DeviceErrorCode::Unavailable, "no-activity-indicator");
        };
        self.host.progress(id, ProgressState::Running);
        let Some(channel) = self.host.open_blob(
            id,
            MIC_CONTENT_TYPE,
            Map::new(),
            BlobSource::Stream { declared: None },
        ) else {
            self.captures.remove(&id);
            return;
        };
        let Some(op) = self.mic_op(id) else { return };
        let lease = Arc::new(guard);
        op.surface = Some(Arc::clone(&lease));
        op.channel = Some(channel);
        op.phase = MicPhase::Recording;
        let format = op.format;
        let max_frames = op.max_bytes / format.frame_bytes();
        let emit = self.emitter(id);
        spawn_named("hypen-device-mic-start", move || {
            if !still_wanted(&lease) {
                return; // ended before the device came up
            }
            let mut converter: Option<PcmConverter> = None;
            let mut limited = false;
            let data_emit = Arc::clone(&emit);
            let sink = Box::new(move |block: AudioBlock| {
                if limited {
                    return;
                }
                let c = converter.get_or_insert_with(|| {
                    PcmConverter::new(block.sample_rate, block.channels, format, Some(max_frames))
                });
                let bytes = c.push_f32(&block.samples);
                if !bytes.is_empty() {
                    data_emit(CaptureEvent::Pcm(bytes));
                }
                if c.is_full() {
                    limited = true;
                    data_emit(CaptureEvent::MicLimit);
                }
            });
            let err_emit = Arc::clone(&emit);
            let on_error = Box::new(move |e: HwError| err_emit(CaptureEvent::MicFailed(e)));
            let started = backend.start(sink, on_error).map(|stream| {
                Box::new(Leased {
                    _hardware: stream,
                    _ui: lease,
                }) as Box<dyn MicStream>
            });
            emit(CaptureEvent::MicStarted(started));
        });
    }

    /// Stop the microphone and the indicator now; the item ends with what
    /// was captured and the success follows once it has uploaded.
    fn finish_recording(&mut self, id: u32) {
        let Some(op) = self.mic_op(id) else { return };
        if !matches!(op.phase, MicPhase::Recording) {
            return;
        }
        op.phase = MicPhase::Finished;
        op.stream = None; // microphone off
        op.surface = None; // indicator down
        let frames = op.bytes / op.format.frame_bytes();
        let rate = op.format.sample_rate;
        let channel = op.channel;
        if let Some(ch) = channel {
            self.host.finish_blob(id, ch);
        }
        let mut result = Map::new();
        result.insert("durationMs".into(), json!(pcm::duration_ms(frames, rate)));
        self.host.succeed(id, result, false);
    }

    // ---- bluetooth.scan -----------------------------------------------------

    fn start_scan(&mut self, id: u32) {
        let Some(backend) = self.hardware.bluetooth.clone() else {
            self.host.fail(id, DeviceErrorCode::Unsupported, None);
            return;
        };
        if !self.ui.can_present() {
            self.host.fail(
                id,
                DeviceErrorCode::Unavailable,
                Some("no-activity-indicator".into()),
            );
            return;
        }
        self.captures.insert(
            id,
            CaptureOp::Scan(ScanOp {
                phase: ScanPhase::Prechecking,
                surface: None,
                handle: None,
                coalescer: Coalescer::default(),
            }),
        );
        let status = self.permission_state(Permission::Bluetooth);
        self.off_worker(id, "hypen-device-ble-check", move || {
            CaptureEvent::Prechecked {
                hardware: backend.check_adapter(),
                permission: status(),
            }
        });
    }

    fn scan_op(&mut self, id: u32) -> Option<&mut ScanOp> {
        match self.captures.get_mut(&id) {
            Some(CaptureOp::Scan(op)) => Some(op),
            _ => None,
        }
    }

    fn on_scan(&mut self, id: u32, event: CaptureEvent) {
        match event {
            CaptureEvent::Prechecked {
                hardware,
                permission,
            } => {
                if let Err(e) = hardware {
                    return self.fail_hw(id, e);
                }
                if let Some((code, detail)) =
                    Self::permission_refusal(Permission::Bluetooth, &permission)
                {
                    return self.fail_op(id, code, detail);
                }
                let need_consent = !self.has_scan_grant();
                let need_os = permission == PermissionState::Prompt;
                if !need_consent && !need_os {
                    return self.begin_scan(id);
                }
                if !self.admit_prompt(id, "bluetooth.scan") {
                    self.captures.remove(&id);
                    return;
                }
                self.host.progress(id, ProgressState::PendingConsent);
                if need_consent {
                    let prompt = ConsentPrompt {
                        origin: self.display_origin(),
                        capability: "bluetooth.scan".into(),
                        operation: "scan for nearby Bluetooth devices".into(),
                        details: vec![
                            "Nearby devices' names and signal strength are shared while the scan runs.".into(),
                        ],
                    };
                    let Some(guard) = self.show(id, Surface::Consent(prompt)) else {
                        return self.modal_refused(id);
                    };
                    if let Some(op) = self.scan_op(id) {
                        op.surface = Some(Arc::new(guard));
                        op.phase = ScanPhase::Consent { permission };
                    }
                } else {
                    if let Some(op) = self.scan_op(id) {
                        op.phase = ScanPhase::AskingPermission;
                    }
                    self.ask_permission(id, Permission::Bluetooth);
                }
            }
            CaptureEvent::PermissionRequested(result) => match result {
                Ok(PermissionState::Granted) => self.begin_scan(id),
                Ok(state) => {
                    let (code, detail) = Self::permission_refusal(Permission::Bluetooth, &state)
                        .unwrap_or((DeviceErrorCode::Denied, "bluetooth".into()));
                    self.fail_op(id, code, detail)
                }
                Err(e) => self.fail_hw(id, e),
            },
            CaptureEvent::Ui(token, action) => {
                let Some(op) = self.scan_op(id) else { return };
                if op.surface.as_ref().map(|s| s.token) != Some(token) {
                    return;
                }
                match (&op.phase, action) {
                    (ScanPhase::Consent { .. }, UiAction::Cancel) => {
                        self.cool_down("bluetooth.scan", DENIAL_COOLDOWN);
                        self.fail_op(id, DeviceErrorCode::Denied, "host-refused");
                    }
                    (ScanPhase::Consent { .. }, UiAction::Dismiss) => {
                        self.cool_down("bluetooth.scan", DISMISSAL_COOLDOWN);
                        self.fail_op(id, DeviceErrorCode::Cancelled, "consent-dismissed");
                    }
                    (ScanPhase::Consent { permission }, UiAction::Continue) => {
                        let ask = *permission == PermissionState::Prompt;
                        op.surface = None;
                        self.remember_scan_grant();
                        if ask {
                            if let Some(op) = self.scan_op(id) {
                                op.phase = ScanPhase::AskingPermission;
                            }
                            self.ask_permission(id, Permission::Bluetooth);
                        } else {
                            self.begin_scan(id);
                        }
                    }
                    (ScanPhase::Scanning, UiAction::Stop) => {
                        self.fail_op(id, DeviceErrorCode::Cancelled, "user-stopped")
                    }
                    (ScanPhase::Scanning, UiAction::Hidden) => {
                        self.fail_op(id, DeviceErrorCode::Cancelled, "indicator-hidden")
                    }
                    _ => {}
                }
            }
            CaptureEvent::ScanStarted(Ok(handle)) => {
                if let Some(op) = self.scan_op(id) {
                    op.handle = Some(handle);
                }
            }
            CaptureEvent::ScanStarted(Err(e)) | CaptureEvent::Scan(ScanEvent::Failed(e)) => {
                self.fail_hw(id, e)
            }
            CaptureEvent::Scan(ScanEvent::Advertisement(adv)) => {
                let now = self.now();
                let wire_id = ble::opaque_id(&self.id_secret, &self.origin, &adv.raw_id);
                let Some(op) = self.scan_op(id) else { return };
                if !matches!(op.phase, ScanPhase::Scanning) {
                    return;
                }
                if let Some(event) =
                    op.coalescer
                        .offer(&wire_id, adv.name.as_deref(), adv.rssi, now)
                {
                    self.host.emit(id, event);
                }
            }
            other => log::debug!("device: scan {id} ignores {other:?}"),
        }
    }

    fn begin_scan(&mut self, id: u32) {
        let Some(backend) = self.hardware.bluetooth.clone() else {
            return;
        };
        self.host.release_prompt(id);
        let spec = IndicatorSpec {
            origin: self.display_origin(),
            kind: IndicatorKind::BluetoothScan,
            activity: SCAN_ACTIVITY.into(),
        };
        let Some(guard) = self.show(id, Surface::Indicator(spec)) else {
            return self.fail_op(id, DeviceErrorCode::Unavailable, "no-activity-indicator");
        };
        let Some(op) = self.scan_op(id) else { return };
        let lease = Arc::new(guard);
        op.surface = Some(Arc::clone(&lease));
        op.phase = ScanPhase::Scanning;
        self.host.progress(id, ProgressState::Running);
        self.spawn_scan(id, backend, lease);
    }

    /// Start a BLE scan off the worker under `lease` (the scanning
    /// indicator or the chooser).
    fn spawn_scan(
        &self,
        id: u32,
        backend: Arc<dyn super::hw::BluetoothBackend>,
        lease: Arc<UiGuard>,
    ) {
        let emit = self.emitter(id);
        spawn_named("hypen-device-ble-scan", move || {
            if !still_wanted(&lease) {
                return;
            }
            let data_emit = Arc::clone(&emit);
            let sink = Box::new(move |e: ScanEvent| data_emit(CaptureEvent::Scan(e)));
            let started = backend.scan(sink).map(|handle| {
                Box::new(Leased {
                    _hardware: handle,
                    _ui: lease,
                }) as Box<dyn ScanHandle>
            });
            emit(CaptureEvent::ScanStarted(started));
        });
    }

    // ---- bluetooth.select ---------------------------------------------------

    fn start_select(&mut self, id: u32, params: &Value) {
        let Some(backend) = self.hardware.bluetooth.clone() else {
            self.host.fail(id, DeviceErrorCode::Unsupported, None);
            return;
        };
        let services: Vec<String> = params
            .get("services")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_ascii_lowercase))
                    .collect()
            })
            .unwrap_or_default();
        let prefix = params
            .get("namePrefix")
            .and_then(Value::as_str)
            .map(str::to_string);
        if !self.ui.can_present() {
            self.host.fail(
                id,
                DeviceErrorCode::Unavailable,
                Some("no-presenter".into()),
            );
            return;
        }
        if !self.admit_prompt(id, "bluetooth.select") {
            return;
        }
        self.host.progress(id, ProgressState::PendingConsent);
        self.captures.insert(
            id,
            CaptureOp::Select(SelectOp {
                services,
                prefix,
                phase: SelectPhase::Prechecking,
                surface: None,
                handle: None,
                entries: Vec::new(),
            }),
        );
        let status = self.permission_state(Permission::Bluetooth);
        self.off_worker(id, "hypen-device-ble-check", move || {
            CaptureEvent::Prechecked {
                hardware: backend.check_adapter(),
                permission: status(),
            }
        });
    }

    fn select_op(&mut self, id: u32) -> Option<&mut SelectOp> {
        match self.captures.get_mut(&id) {
            Some(CaptureOp::Select(op)) => Some(op),
            _ => None,
        }
    }

    fn on_select(&mut self, id: u32, event: CaptureEvent) {
        match event {
            CaptureEvent::Prechecked {
                hardware,
                permission,
            } => {
                if let Err(e) = hardware {
                    return self.fail_hw(id, e);
                }
                if let Some((code, detail)) =
                    Self::permission_refusal(Permission::Bluetooth, &permission)
                {
                    return self.fail_op(id, code, detail);
                }
                if permission == PermissionState::Prompt {
                    if let Some(op) = self.select_op(id) {
                        op.phase = SelectPhase::AskingPermission;
                    }
                    return self.ask_permission(id, Permission::Bluetooth);
                }
                self.open_chooser(id);
            }
            CaptureEvent::PermissionRequested(result) => match result {
                Ok(PermissionState::Granted) => self.open_chooser(id),
                Ok(state) => {
                    let (code, detail) = Self::permission_refusal(Permission::Bluetooth, &state)
                        .unwrap_or((DeviceErrorCode::Denied, "bluetooth".into()));
                    self.fail_op(id, code, detail)
                }
                Err(e) => self.fail_hw(id, e),
            },
            CaptureEvent::Ui(token, action) => {
                let Some(op) = self.select_op(id) else { return };
                if op.surface.as_ref().map(|s| s.token) != Some(token) {
                    return;
                }
                match action {
                    UiAction::Choose(chosen) => {
                        let Some(entry) = op.entries.iter().find(|e| e.id == chosen).cloned()
                        else {
                            return; // not a listed device: ignored
                        };
                        let mut device = Map::new();
                        device.insert("id".into(), json!(entry.id));
                        if let Some(name) = entry.name {
                            device.insert("name".into(), json!(name));
                        }
                        self.captures.remove(&id); // chooser closes, scan stops
                        let mut result = Map::new();
                        result.insert("device".into(), Value::Object(device));
                        self.host.succeed(id, result, false);
                    }
                    UiAction::Cancel | UiAction::Dismiss => {
                        self.cool_down("bluetooth.select", DISMISSAL_COOLDOWN);
                        self.fail_op(id, DeviceErrorCode::Cancelled, "chooser-dismissed");
                    }
                    _ => {}
                }
            }
            CaptureEvent::ScanStarted(Ok(handle)) => {
                if let Some(op) = self.select_op(id) {
                    op.handle = Some(handle);
                }
            }
            CaptureEvent::ScanStarted(Err(e)) | CaptureEvent::Scan(ScanEvent::Failed(e)) => {
                self.fail_hw(id, e)
            }
            CaptureEvent::Scan(ScanEvent::Advertisement(adv)) => {
                let wire_id = ble::opaque_id(&self.id_secret, &self.origin, &adv.raw_id);
                let ui = Arc::clone(&self.ui);
                let Some(op) = self.select_op(id) else { return };
                if !ble::passes_filters(
                    adv.name.as_deref(),
                    &adv.services,
                    &op.services,
                    op.prefix.as_deref(),
                ) {
                    return;
                }
                let name = ble::clean_name(adv.name.as_deref());
                let at = op.entries.iter().position(|e| e.id == wire_id);
                let full = op.entries.len() >= ble::MAX_LISTED;
                let changed = match at.map(|i| &mut op.entries[i]) {
                    Some(entry) => {
                        let changed =
                            entry.rssi != adv.rssi || (name.is_some() && entry.name != name);
                        entry.rssi = adv.rssi;
                        if name.is_some() {
                            entry.name = name;
                        }
                        changed
                    }
                    None if full => false,
                    None => {
                        op.entries.push(ChooserEntry {
                            id: wire_id,
                            name,
                            rssi: adv.rssi,
                        });
                        true
                    }
                };
                if changed {
                    if let Some(s) = &op.surface {
                        ui.update(s.id, SurfaceUpdate::Devices(op.entries.clone()));
                    }
                }
            }
            other => log::debug!("device: select {id} ignores {other:?}"),
        }
    }

    fn open_chooser(&mut self, id: u32) {
        let Some(backend) = self.hardware.bluetooth.clone() else {
            return;
        };
        let Some(op) = self.select_op(id) else { return };
        let mut filters = Vec::new();
        if !op.services.is_empty() {
            filters.push(format!("Services: {}", op.services.join(", ")));
        }
        if let Some(p) = &op.prefix {
            filters.push(format!("Name starts with: {p}"));
        }
        let prompt = ChooserPrompt {
            origin: self.display_origin(),
            filters,
        };
        let Some(guard) = self.show(id, Surface::Chooser(prompt)) else {
            return self.modal_refused(id);
        };
        let Some(op) = self.select_op(id) else { return };
        let lease = Arc::new(guard);
        op.surface = Some(Arc::clone(&lease));
        op.phase = SelectPhase::Choosing;
        self.spawn_scan(id, backend, lease);
    }

    // ---- permission.query / permission.request -------------------------------

    fn on_permission(&mut self, id: u32, event: CaptureEvent) {
        let Some(CaptureOp::Permission(op)) = self.captures.get_mut(&id) else {
            return;
        };
        let p = op.permission;
        let answer =
            |state: &PermissionState| -> Result<Map<String, Value>, (DeviceErrorCode, String)> {
                match state {
                    PermissionState::Unsupported => {
                        Err((DeviceErrorCode::Unsupported, p.as_str().into()))
                    }
                    PermissionState::NotDeclared => Err((
                        DeviceErrorCode::Unavailable,
                        format!("not-declared:{}", p.as_str()),
                    )),
                    s => {
                        let mut m = Map::new();
                        m.insert("status".into(), json!(s.wire().unwrap_or("prompt")));
                        Ok(m)
                    }
                }
            };
        match event {
            CaptureEvent::Prechecked { permission, .. }
                if matches!(op.phase, PermPhase::Querying) =>
            {
                // `permission.query` never prompts; `permission.request`
                // answers an already-decided permission without a dialog.
                if !op.request || permission != PermissionState::Prompt {
                    self.captures.remove(&id);
                    match answer(&permission) {
                        Ok(r) => self.host.succeed(id, r, false),
                        Err((code, detail)) => self.host.fail(id, code, Some(detail)),
                    }
                    return;
                }
                if !self.ui.can_present() {
                    return self.fail_op(id, DeviceErrorCode::Unavailable, "no-presenter");
                }
                if !self.admit_prompt(id, "permission.request") {
                    self.captures.remove(&id);
                    return;
                }
                self.host.progress(id, ProgressState::PendingConsent);
                let operation = match p {
                    Permission::Camera => "use your camera",
                    Permission::Microphone => "use your microphone",
                    Permission::Bluetooth => "use Bluetooth",
                    _ => "use a device permission",
                };
                let prompt = ConsentPrompt {
                    origin: self.display_origin(),
                    capability: "permission.request".into(),
                    operation: operation.into(),
                    details: vec!["The system will ask you next.".into()],
                };
                let Some(guard) = self.show(id, Surface::Consent(prompt)) else {
                    return self.modal_refused(id);
                };
                if let Some(CaptureOp::Permission(op)) = self.captures.get_mut(&id) {
                    op.surface = Some(Arc::new(guard));
                    op.phase = PermPhase::Consent;
                }
            }
            CaptureEvent::Ui(token, action) if matches!(op.phase, PermPhase::Consent) => {
                if op.surface.as_ref().map(|s| s.token) != Some(token) {
                    return;
                }
                match action {
                    UiAction::Continue => {
                        op.surface = None;
                        op.phase = PermPhase::Requesting;
                        self.host.progress(id, ProgressState::Running);
                        self.ask_permission(id, p);
                    }
                    UiAction::Cancel => {
                        self.cool_down("permission.request", DENIAL_COOLDOWN);
                        self.fail_op(id, DeviceErrorCode::Denied, "host-refused");
                    }
                    UiAction::Dismiss => {
                        self.cool_down("permission.request", DISMISSAL_COOLDOWN);
                        self.fail_op(id, DeviceErrorCode::Cancelled, "consent-dismissed");
                    }
                    _ => {}
                }
            }
            CaptureEvent::PermissionRequested(result)
                if matches!(op.phase, PermPhase::Requesting) =>
            {
                self.captures.remove(&id);
                self.host.release_prompt(id);
                match result {
                    Ok(state) => match answer(&state) {
                        Ok(r) => self.host.succeed(id, r, false),
                        Err((code, detail)) => self.host.fail(id, code, Some(detail)),
                    },
                    Err(e) => self.host.fail(id, e.code(), Some(e.detail())),
                }
            }
            other => log::debug!("device: permission {id} ignores {other:?}"),
        }
    }
}

/// A test/diagnostic view of what a live capture holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStatus {
    pub capability: &'static str,
    pub hardware_active: bool,
    pub surface: Option<SurfaceId>,
}

impl CaptureOp {
    #[cfg(test)]
    pub(crate) fn status(&self) -> CaptureStatus {
        match self {
            CaptureOp::Camera(op) => CaptureStatus {
                capability: "camera.capture",
                hardware_active: op.commands.is_some(),
                surface: op.surface.as_ref().map(|s| s.id),
            },
            CaptureOp::Mic(op) => CaptureStatus {
                capability: "mic.record",
                hardware_active: op.stream.is_some(),
                surface: op.surface.as_ref().map(|s| s.id),
            },
            CaptureOp::Scan(op) => CaptureStatus {
                capability: "bluetooth.scan",
                hardware_active: op.handle.is_some(),
                surface: op.surface.as_ref().map(|s| s.id),
            },
            CaptureOp::Select(op) => CaptureStatus {
                capability: "bluetooth.select",
                hardware_active: op.handle.is_some(),
                surface: op.surface.as_ref().map(|s| s.id),
            },
            CaptureOp::Permission(op) => CaptureStatus {
                capability: if op.request {
                    "permission.request"
                } else {
                    "permission.query"
                },
                hardware_active: false,
                surface: op.surface.as_ref().map(|s| s.id),
            },
        }
    }
}
