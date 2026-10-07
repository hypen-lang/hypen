//! The desktop DeviceHost (RFC 001, Device Capability Protocol, client role).
//!
//! A Hypen server calls `context.device.request(...)`; the connected client's
//! DeviceHost runs the operation and streams the result back. On the desktop
//! that host is this module:
//!
//! - [`host::DeviceHost`] — the sans-IO protocol core (handshake acceptance,
//!   admission against the live selection, leases, deadlines, credit, upload
//!   framing, download verification, every violation rule);
//! - [`dialogs`] — the native file dialogs that are each operation's consent
//!   gate;
//! - `DesktopDevice` (crate-internal) — the IO owner inside
//!   [`crate::RemoteModule`]'s WebSocket worker: it feeds the core, runs the
//!   dialogs off the worker, streams picked files lazily as credit allows,
//!   and writes downloads to a temporary file that is renamed into place only
//!   after size and SHA-256 verify.
//!
//! # What the desktop advertises
//!
//! [`DeviceConfig::native`] offers exactly what this build implements and
//! can present (the advertisement rule of §2.2 never depends on grant
//! state or on which hardware happens to be plugged in right now):
//!
//! | Capability | Driver | Cargo feature |
//! |---|---|---|
//! | `core.capabilities@1` | the host itself (always) | — |
//! | `file.pick@1` | native open dialog (multi-select up to `maxCount`), files streamed lazily | — |
//! | `gallery.pick@1` | native open dialog filtered to image / video types per `mediaTypes` | — |
//! | `file.save@1` | native save dialog, then a streamed, hash-verified download | — |
//! | `camera.capture@1` | in-window capture panel (live preview); photo → `image/jpeg`, video → fragmented H.264 `video/mp4` streamed as recorded | `camera` |
//! | `mic.record@1` | consent dialog + recording indicator; `audio/L16` PCM16 at the requested rate/channels | `mic` |
//! | `bluetooth.scan@1` | consent dialog + scanning indicator; coalesced `{device:{id,name?,rssi}}` events | `bluetooth` |
//! | `bluetooth.select@1` | in-window chooser listing a live filtered scan | `bluetooth` |
//! | `permission.query@1` / `permission.request@1` | the OS permission model ([`native::permissions`]) | — |
//!
//! File capabilities need a dialog backend (a display); the others need the
//! in-window host UI ([`ui::DeviceUi`], a display) and their backend. With a
//! feature compiled out, its capabilities are not advertised and a server
//! request is refused `unsupported`. Missing hardware at request time is
//! `unavailable` (`no-camera`, `no-microphone`, `no-adapter`). The drivers
//! and their user-visible flows are documented in [`capture`].
//!
//! [`DeviceConfig::with_dialogs`] is the file-dialog-only host (tests,
//! kiosks); [`DeviceConfig::with_capture`] adds capture backends and a UI.
//!
//! # Dropping files on a pick
//!
//! When `file.pick` / `gallery.pick` arrives while files from the OS are
//! being dragged over the window ([`DeviceUi::file_drag_in_progress`]: the
//! drag is hovering, or a files zone's `.onFileDragEnter` fired within
//! [`ui::FILE_DRAG_GRACE`]), the host shows its own consent surface
//! ([`ui::Surface::FileDrop`]) instead of the OS open panel: "<origin>
//! wants to choose files", a drop area, Cancel / Continue. Releasing the
//! files on the armed drop area (the window's overlay enforces input
//! protection and that the drag entered the armed area) is the per-use
//! choice: the dropped paths are filtered by `accept` (the OS panel's
//! filter) or `mediaTypes`, cut to `maxCount`, and streamed exactly like
//! picked files. Continue opens the OS panel as without a drag; Cancel is
//! a host refusal (`denied`), Escape an abandonment (`cancelled`), as on
//! the other consent surfaces. Without a drag, the OS panel opens directly.

pub mod ble;
pub mod camera;
pub mod capture;
pub mod dialogs;
pub mod host;
pub mod hw;
pub mod mp4;
pub mod native;
pub mod overlay;
pub mod pcm;
pub mod ui;

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hypen_engine::serialize::device::{DeviceErrorCode, ProgressState};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

pub use dialogs::{
    content_type_for, DialogUnavailable, FileDialogs, NativeFileDialogs, PickDialog, SaveDialog,
};
pub use host::{BlobSource, DeviceHost, HostOptions, HostOutput, StartRequest};
pub use hw::Hardware;
pub use ui::{overlay_hub, DeviceUi, HeadlessUi, OverlayHub};

use capture::{CaptureEvent, CaptureOp, UiGuard};
use ui::{FileDropPrompt, Surface, UiAction};

/// The file capabilities (native dialogs).
pub const FILE_CAPABILITIES: &[&str] = &["file.pick", "gallery.pick", "file.save"];

/// Every capability the desktop host has a driver for in this build.
pub const IMPLEMENTED: &[&str] = &[
    "file.pick",
    "gallery.pick",
    "file.save",
    "camera.capture",
    "mic.record",
    "bluetooth.scan",
    "bluetooth.select",
    "permission.query",
    "permission.request",
];

/// Download credit window: at most this many bytes are granted ahead of what
/// has reached the destination file (§2.4: ≤ 256 KiB).
const DOWNLOAD_WINDOW: u64 = 256 * 1024;

/// How the desktop device host is configured on a [`crate::RemoteModule`].
#[derive(Clone)]
pub struct DeviceConfig {
    /// The dialogs every file driver's consent gate uses.
    pub dialogs: Arc<dyn FileDialogs>,
    /// The capabilities to offer (a subset of [`IMPLEMENTED`]).
    pub capabilities: Vec<String>,
    /// Client-local protocol policy.
    pub options: HostOptions,
    /// The host UI of the capture drivers (consent dialogs, capture panel,
    /// chooser, indicators).
    pub ui: Arc<dyn DeviceUi>,
    /// The capture hardware; `None` backends are not advertised.
    pub hardware: Hardware,
}

impl std::fmt::Debug for DeviceConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceConfig")
            .field("capabilities", &self.capabilities)
            .field("options", &self.options)
            .field("hardware", &self.hardware)
            .finish()
    }
}

impl DeviceConfig {
    /// The native desktop host: OS file dialogs, the renderer window's host
    /// UI ([`overlay_hub`]) and every hardware backend compiled into this
    /// build (features `camera`, `mic`, `bluetooth`).
    pub fn native() -> Self {
        Self::with_dialogs(Arc::new(NativeFileDialogs))
            .with_capture(overlay_hub(), Hardware::native())
    }

    /// The file capabilities only, behind `dialogs` (tests, kiosks,
    /// scripted automation). Add capture drivers with
    /// [`Self::with_capture`].
    pub fn with_dialogs(dialogs: Arc<dyn FileDialogs>) -> Self {
        DeviceConfig {
            dialogs,
            capabilities: IMPLEMENTED.iter().map(|s| s.to_string()).collect(),
            options: HostOptions::default(),
            ui: Arc::new(HeadlessUi),
            hardware: Hardware::default(),
        }
    }

    /// Capture drivers presenting through `ui` on `hardware`.
    pub fn with_capture(mut self, ui: Arc<dyn DeviceUi>, hardware: Hardware) -> Self {
        self.ui = ui;
        self.hardware = hardware;
        self
    }

    /// Offer only `capabilities` (names outside [`IMPLEMENTED`] are ignored).
    pub fn capabilities(mut self, capabilities: &[&str]) -> Self {
        self.capabilities = capabilities.iter().map(|s| s.to_string()).collect();
        self
    }

    /// The names actually advertised: implemented, requested, and only when
    /// their gate can be shown on this machine and their backend is in the
    /// build.
    pub fn advertised(&self) -> Vec<&'static str> {
        let dialogs = self.dialogs.available();
        let ui = self.ui.available();
        let hw = &self.hardware;
        IMPLEMENTED
            .iter()
            .copied()
            .filter(|c| self.capabilities.iter().any(|x| x == c))
            .filter(|c| match *c {
                "file.pick" | "gallery.pick" | "file.save" => dialogs,
                "camera.capture" => ui && hw.camera.is_some(),
                "mic.record" => ui && hw.mic.is_some(),
                "bluetooth.scan" | "bluetooth.select" => ui && hw.bluetooth.is_some(),
                "permission.query" | "permission.request" => ui && hw.permissions.is_some(),
                _ => false,
            })
            .collect()
    }
}

/// What the device host asks the socket worker to put on the wire.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WireOut {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

/// A dialog's answer, delivered back to the worker.
#[derive(Debug)]
pub(crate) enum DriverMsg {
    Picked {
        epoch: u64,
        id: u32,
        result: Result<Option<Vec<PathBuf>>, DialogUnavailable>,
    },
    SaveChosen {
        epoch: u64,
        id: u32,
        result: Result<Option<PathBuf>, DialogUnavailable>,
    },
    /// A capture driver's thread / hardware callback / host UI.
    Capture {
        epoch: u64,
        id: u32,
        event: CaptureEvent,
    },
}

enum DriverOp {
    Picking { capability: String, params: Value },
    Choosing { declared: u64 },
    Saving(PendingSave),
}

/// A pick waiting on the file drop surface.
struct DropPick {
    id: u32,
    /// Closes the surface when dropped.
    guard: UiGuard,
    /// The OS panel Continue opens.
    dialog: PickDialog,
}

struct PendingSave {
    temp: PathBuf,
    dest: PathBuf,
    file: Option<File>,
    declared: u64,
    written: u64,
    granted: u64,
}

/// The device host inside one [`crate::RemoteModule`] worker. Lives as long
/// as the module; [`Self::attach`] binds it to each new socket.
pub(crate) struct DesktopDevice {
    host: DeviceHost,
    dialogs: Arc<dyn FileDialogs>,
    origin: String,
    /// Bumped per socket and on detach: dialog answers of an older socket
    /// are dropped.
    epoch: u64,
    start: Instant,
    tx: mpsc::UnboundedSender<DriverMsg>,
    /// A physical dialog on screen (it may outlive its request: an OS dialog
    /// cannot always be dismissed). No second dialog opens meanwhile.
    dialog_open: Option<(u64, u32)>,
    ops: HashMap<u32, DriverOp>,
    /// The pick whose file drop surface is up (see the module docs).
    drop_pick: Option<DropPick>,
    // ---- capture drivers (see `capture`) ----
    ui: Arc<dyn DeviceUi>,
    hardware: Hardware,
    captures: HashMap<u32, CaptureOp>,
    next_token: u64,
    /// Persistable consent (`bluetooth.scan`) for `wss://` origins, with
    /// expiry; survives reconnects for the life of the process.
    grants: HashMap<(String, String), Instant>,
    /// Consent for non-authenticated origins: this connection only.
    connection_grants: HashSet<(String, String)>,
    /// Refusal / dismissal cooldowns per (origin, capability).
    cooldowns: HashMap<(String, String), Instant>,
    /// Keys the opaque Bluetooth device ids.
    id_secret: [u8; 32],
}

impl DesktopDevice {
    /// A host for `config` whose dialog answers arrive on `tx` (the worker
    /// feeds them back through [`Self::on_driver`]).
    pub(crate) fn new(config: &DeviceConfig, tx: mpsc::UnboundedSender<DriverMsg>) -> Self {
        DesktopDevice {
            host: DeviceHost::new(&config.advertised(), config.options),
            dialogs: Arc::clone(&config.dialogs),
            origin: String::new(),
            epoch: 0,
            start: Instant::now(),
            tx,
            dialog_open: None,
            ops: HashMap::new(),
            drop_pick: None,
            ui: Arc::clone(&config.ui),
            hardware: config.hardware.clone(),
            captures: HashMap::new(),
            next_token: 0,
            grants: HashMap::new(),
            connection_grants: HashSet::new(),
            cooldowns: HashMap::new(),
            id_secret: if config.hardware.bluetooth.is_some() {
                ble::install_secret()
            } else {
                [0; 32]
            },
        }
    }

    pub(crate) fn now(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// What each live capture holds (tests and diagnostics).
    #[cfg(test)]
    pub(crate) fn capture_status(&self, id: u32) -> Option<capture::CaptureStatus> {
        self.captures.get(&id).map(CaptureOp::status)
    }

    /// The core (tests and diagnostics).
    #[cfg(test)]
    pub(crate) fn host(&self) -> &DeviceHost {
        &self.host
    }

    /// A new socket to `origin` (`scheme://host[:port]` of the server).
    pub(crate) fn attach(&mut self, origin: String) {
        self.detach();
        self.origin = origin;
        self.host.attach();
    }

    /// The socket closed: stop every operation and clean up (temp files are
    /// deleted; an open OS dialog's late answer is ignored).
    pub(crate) fn detach(&mut self) {
        self.epoch += 1;
        self.host.detach();
        let _ = self.drain();
        self.drop_pick = None;
        for (_, op) in self.ops.drain() {
            if let DriverOp::Saving(save) = op {
                discard(save);
            }
        }
        // Hardware off, host UI down, nothing sent (§2.5).
        self.captures.clear();
        self.connection_grants.clear();
    }

    pub(crate) fn hello_device(&self) -> Value {
        self.host.hello_device()
    }

    pub(crate) fn on_ack(&mut self, device_raw: Option<&str>) {
        self.host.on_ack(device_raw);
    }

    pub(crate) fn on_text(&mut self, text: &str) {
        let now = self.now();
        self.host.on_text(text, now);
    }

    pub(crate) fn on_frame(&mut self, frame: &[u8]) {
        let now = self.now();
        self.host.on_frame(frame, now);
    }

    pub(crate) fn tick(&mut self) {
        let now = self.now();
        self.host.tick(now);
    }

    /// When the worker must call [`Self::tick`] next.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.host
            .next_deadline()
            .map(|ms| self.start + Duration::from_millis(ms))
    }

    pub(crate) fn has_ready_work(&self) -> bool {
        self.host.has_ready_work()
    }

    /// Process everything the core asks for and return what goes on the
    /// wire, stopping after one upload frame so pending UI traffic is served
    /// between bulk chunks (§2.3).
    pub(crate) fn drain(&mut self) -> Vec<WireOut> {
        let mut wire = Vec::new();
        loop {
            let outs = self.host.poll();
            if outs.is_empty() {
                break;
            }
            let mut framed = false;
            for out in outs {
                match out {
                    HostOutput::SendText(t) => wire.push(WireOut::Text(t)),
                    HostOutput::SendFrame(f) => {
                        framed = true;
                        wire.push(WireOut::Binary(f));
                    }
                    HostOutput::Close { code, reason } => wire.push(WireOut::Close(code, reason)),
                    HostOutput::Start(req) => self.start_driver(req),
                    HostOutput::Stop { id } => self.stop_driver(id),
                    HostOutput::DownloadChunk { id, bytes } => self.write_download(id, &bytes),
                    HostOutput::DownloadComplete { id } => self.commit_download(id),
                }
            }
            if framed {
                break;
            }
        }
        wire
    }

    // ---- drivers -------------------------------------------------------------

    fn start_driver(&mut self, req: StartRequest) {
        let id = req.id;
        match req.capability.as_str() {
            "file.pick" | "gallery.pick" | "file.save" => {}
            c if capture::CAPTURE_CAPABILITIES.contains(&c) => {
                self.start_capture(req);
                return;
            }
            _ => {
                self.host.fail(id, DeviceErrorCode::Unsupported, None);
                return;
            }
        }
        // One prompt-raising operation per host (§5); a physical dialog that
        // outlived its request still counts. A pick also honours the cooldown
        // a refused / dismissed drop surface set.
        if req.capability != "file.save" {
            if !self.admit_prompt(id, &req.capability) {
                return;
            }
        } else if self.dialog_open.is_some() || !self.host.acquire_prompt(id) {
            self.host.fail(
                id,
                DeviceErrorCode::Throttled,
                Some("another device prompt is open".into()),
            );
            return;
        }
        self.host.progress(id, ProgressState::PendingConsent);
        let epoch = self.epoch;
        let tx = self.tx.clone();
        let dialogs = Arc::clone(&self.dialogs);
        let origin = self.display_origin();
        if req.capability == "file.save" {
            self.dialog_open = Some((self.epoch, id));
            let name = req.params.get("name").and_then(Value::as_str).unwrap_or("");
            let declared = req.params.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            let file_name = dialogs::sanitize_file_name(name);
            let filters = std::path::Path::new(&file_name)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    vec![(
                        format!("{} file", e.to_ascii_uppercase()),
                        vec![e.to_string()],
                    )]
                })
                .unwrap_or_default();
            let dialog = SaveDialog {
                title: format!("{origin} wants to save \"{file_name}\" ({declared} bytes)"),
                file_name,
                filters,
            };
            self.ops.insert(id, DriverOp::Choosing { declared });
            spawn_dialog(move || {
                let result = dialogs.save_file(&dialog);
                let _ = tx.send(DriverMsg::SaveChosen { epoch, id, result });
            });
        } else {
            let gallery = req.capability == "gallery.pick";
            let max_count = req
                .params
                .get("maxCount")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let filters = if gallery {
                let mut exts = Vec::new();
                let media = req.params.get("mediaTypes").and_then(Value::as_array);
                for m in media.into_iter().flatten().filter_map(Value::as_str) {
                    match m {
                        "photo" => exts.extend(dialogs::extensions_with_prefix("image/")),
                        "video" => exts.extend(dialogs::extensions_with_prefix("video/")),
                        _ => {}
                    }
                }
                vec![("Photos and videos".to_string(), exts)]
            } else {
                let accept: Vec<String> = req
                    .params
                    .get("accept")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                dialogs::filters_for_accept(&accept)
            };
            let what = if gallery { "photos or videos" } else { "files" };
            let dialog = PickDialog {
                title: if max_count > 1 {
                    format!("{origin} requests up to {max_count} {what}")
                } else {
                    format!("{origin} requests a file")
                },
                filters,
                multiple: max_count > 1,
            };
            self.ops.insert(
                id,
                DriverOp::Picking {
                    capability: req.capability.clone(),
                    params: req.params.clone(),
                },
            );
            // Files are being dragged over the window: offer the host's
            // drop surface first (Continue still reaches the OS panel).
            if self.ui.file_drag_in_progress() {
                let prompt = FileDropPrompt {
                    origin: origin.clone(),
                    capability: req.capability.clone(),
                    operation: if max_count > 1 {
                        format!("choose up to {max_count} {what}")
                    } else if gallery {
                        "choose a photo or video".into()
                    } else {
                        "choose a file".into()
                    },
                    multiple: max_count > 1,
                    details: dialog
                        .filters
                        .iter()
                        .filter(|(_, exts)| !exts.is_empty())
                        .map(|(_, exts)| {
                            let list: Vec<String> = exts.iter().map(|e| format!(".{e}")).collect();
                            format!("Accepts {}", list.join(", "))
                        })
                        .collect(),
                };
                if let Some(guard) = self.show(id, Surface::FileDrop(prompt)) {
                    self.drop_pick = Some(DropPick { id, guard, dialog });
                    return;
                }
            }
            self.open_pick_dialog(id, dialog);
        }
    }

    /// The OS open panel for pick `id` (its answer comes back as
    /// [`DriverMsg::Picked`]).
    fn open_pick_dialog(&mut self, id: u32, dialog: PickDialog) {
        self.dialog_open = Some((self.epoch, id));
        let epoch = self.epoch;
        let tx = self.tx.clone();
        let dialogs = Arc::clone(&self.dialogs);
        spawn_dialog(move || {
            let result = dialogs.pick_files(&dialog);
            let _ = tx.send(DriverMsg::Picked { epoch, id, result });
        });
    }

    /// The user acted on the file drop surface of pick `id`.
    fn on_drop_ui(&mut self, id: u32, action: UiAction) {
        if !self.host.is_live(id) {
            self.drop_pick = None;
            self.ops.remove(&id);
            return;
        }
        let capability = match self.ops.get(&id) {
            Some(DriverOp::Picking { capability, .. }) => capability.clone(),
            _ => return,
        };
        match action {
            UiAction::Continue => {
                let Some(pick) = self.drop_pick.take() else {
                    return;
                };
                drop(pick.guard); // the surface closes; the OS panel opens
                self.open_pick_dialog(id, pick.dialog);
            }
            UiAction::Cancel => {
                self.drop_pick = None;
                self.ops.remove(&id);
                self.cool_down(&capability, capture::DENIAL_COOLDOWN);
                self.host
                    .fail(id, DeviceErrorCode::Denied, Some("host-refused".into()));
            }
            UiAction::Dismiss => {
                self.drop_pick = None;
                self.ops.remove(&id);
                self.cool_down(&capability, capture::DISMISSAL_COOLDOWN);
                self.host.fail(
                    id,
                    DeviceErrorCode::Cancelled,
                    Some("consent-dismissed".into()),
                );
            }
            UiAction::Dropped(paths) => {
                let paths = self.droppable(id, paths);
                if paths.is_empty() {
                    // Nothing the request takes (wrong types, folders): the
                    // surface stays up for another drop, Continue or Cancel.
                    log::debug!("device: drop on pick {id} had no acceptable file");
                    return;
                }
                self.drop_pick = None; // the surface closes
                self.host.release_prompt(id);
                self.picked(id, Ok(Some(paths)));
            }
            // A minimized window keeps the surface; it re-arms on return.
            _ => {}
        }
    }

    /// The dropped paths pick `id` would have let the user choose in the OS
    /// panel: regular files only, inside its `accept` filter (`file.pick`;
    /// `gallery.pick`'s `mediaTypes` and every pick's `maxCount` are applied
    /// by [`Self::picked`], as for the panel's answer).
    fn droppable(&self, id: u32, paths: Vec<PathBuf>) -> Vec<PathBuf> {
        let Some(pick) = self.drop_pick.as_ref().filter(|p| p.id == id) else {
            return Vec::new();
        };
        let allowed: Vec<&String> = pick
            .dialog
            .filters
            .iter()
            .flat_map(|(_, exts)| exts.iter())
            .collect();
        paths
            .into_iter()
            .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file()))
            .filter(|p| {
                allowed.is_empty()
                    || p.extension()
                        .and_then(|e| e.to_str())
                        .map(str::to_ascii_lowercase)
                        .is_some_and(|e| allowed.iter().any(|a| **a == e))
            })
            .collect()
    }

    /// A dialog answered.
    pub(crate) fn on_driver(&mut self, msg: DriverMsg) {
        let (epoch, id) = match &msg {
            DriverMsg::Picked { epoch, id, .. } | DriverMsg::SaveChosen { epoch, id, .. } => {
                (*epoch, *id)
            }
            DriverMsg::Capture { epoch, id, .. } => (*epoch, *id),
        };
        if let DriverMsg::Capture { event, .. } = msg {
            // An older socket's hardware / UI: whatever it carries drops.
            if epoch != self.epoch {
                return;
            }
            if let CaptureEvent::Ui(token, action) = &event {
                if let Some(pick) = self.drop_pick.as_ref().filter(|p| p.id == id) {
                    if pick.guard.token == *token {
                        let action = action.clone();
                        self.on_drop_ui(id, action);
                    }
                    return;
                }
            }
            self.on_capture(id, event);
            return;
        }
        if self.dialog_open == Some((epoch, id)) {
            self.dialog_open = None;
        }
        if epoch != self.epoch {
            return; // an older socket's dialog
        }
        self.host.release_prompt(id);
        // Cancelled / timed out meanwhile: a late OS result never uploads
        // or writes anything (§2.1 "Cancellation").
        if !self.host.is_live(id) {
            self.ops.remove(&id);
            return;
        }
        match msg {
            DriverMsg::Picked { result, .. } => self.picked(id, result),
            DriverMsg::SaveChosen { result, .. } => self.save_chosen(id, result),
            DriverMsg::Capture { .. } => {}
        }
    }

    fn picked(&mut self, id: u32, result: Result<Option<Vec<PathBuf>>, DialogUnavailable>) {
        let Some(DriverOp::Picking { capability, params }) = self.ops.remove(&id) else {
            return;
        };
        let paths = match result {
            Err(DialogUnavailable(detail)) => {
                self.host
                    .fail(id, DeviceErrorCode::Unavailable, Some(detail));
                return;
            }
            Ok(None) => {
                self.host
                    .fail(id, DeviceErrorCode::Cancelled, Some("dismissed".into()));
                return;
            }
            Ok(Some(paths)) => paths,
        };
        let gallery = capability == "gallery.pick";
        let max_count = params.get("maxCount").and_then(Value::as_u64).unwrap_or(1) as usize;
        let wants = |ct: &str| -> bool {
            if !gallery {
                return true;
            }
            let media = params.get("mediaTypes").and_then(Value::as_array);
            media
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|m| {
                    (m == "photo" && ct.starts_with("image/"))
                        || (m == "video" && ct.starts_with("video/"))
                })
        };
        let chosen: Vec<(PathBuf, &'static str)> = paths
            .into_iter()
            .map(|p| {
                let ct = content_type_for(&p);
                (p, ct)
            })
            .filter(|(_, ct)| wants(ct))
            .take(max_count)
            .collect();
        if chosen.is_empty() {
            let detail = if gallery {
                "no photo or video chosen"
            } else {
                "no file chosen"
            };
            self.host
                .fail(id, DeviceErrorCode::Cancelled, Some(detail.into()));
            return;
        }
        // Open everything first: a failure uploads nothing.
        let mut opened = Vec::with_capacity(chosen.len());
        for (path, ct) in chosen {
            let file = match File::open(&path) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("device: cannot open {}: {e}", path.display());
                    self.host.fail(
                        id,
                        DeviceErrorCode::Internal,
                        Some("cannot read the chosen file".into()),
                    );
                    return;
                }
            };
            let len = match file.metadata() {
                Ok(m) if m.is_file() => m.len(),
                _ => {
                    self.host.fail(
                        id,
                        DeviceErrorCode::Internal,
                        Some("not a regular file".into()),
                    );
                    return;
                }
            };
            opened.push((path, ct, file, len));
        }
        self.host.progress(id, ProgressState::Running);
        for (path, ct, file, len) in opened {
            let mut extra = Map::new();
            if !gallery {
                let name: String = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .chars()
                    .take(hypen_engine::serialize::device::limits::FILE_NAME_MAX)
                    .collect();
                extra.insert("name".into(), Value::String(name));
            }
            let source = BlobSource::Reader {
                reader: Box::new(file),
                len,
            };
            if self.host.open_blob(id, ct, extra, source).is_none() {
                return; // the request ended; the reason was sent
            }
        }
        self.host.succeed(id, Map::new(), false);
    }

    fn save_chosen(&mut self, id: u32, result: Result<Option<PathBuf>, DialogUnavailable>) {
        let Some(DriverOp::Choosing { declared }) = self.ops.remove(&id) else {
            return;
        };
        let dest = match result {
            Err(DialogUnavailable(detail)) => {
                self.host
                    .fail(id, DeviceErrorCode::Unavailable, Some(detail));
                return;
            }
            Ok(None) => {
                self.host
                    .fail(id, DeviceErrorCode::Cancelled, Some("dismissed".into()));
                return;
            }
            Ok(Some(dest)) => dest,
        };
        // Write into a temporary file beside the destination; it is renamed
        // into place only after the declared size and SHA-256 verify.
        let dir = dest
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let base = dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".into());
        let temp = dir.join(format!(".{base}.hypen-{}-{id}.part", std::process::id()));
        let file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(f) => f,
            Err(e) => {
                log::warn!("device: cannot create {}: {e}", temp.display());
                self.host.fail(
                    id,
                    DeviceErrorCode::Internal,
                    Some("cannot write the chosen destination".into()),
                );
                return;
            }
        };
        self.host.progress(id, ProgressState::Running);
        let mut save = PendingSave {
            temp,
            dest,
            file: Some(file),
            declared,
            written: 0,
            granted: 0,
        };
        // Consent and destination first, then a bounded credit window (§2.4).
        save.granted = self.host.grant_download(id, DOWNLOAD_WINDOW.min(declared));
        self.ops.insert(id, DriverOp::Saving(save));
    }

    fn write_download(&mut self, id: u32, bytes: &[u8]) {
        let Some(DriverOp::Saving(save)) = self.ops.get_mut(&id) else {
            return;
        };
        let ok = save
            .file
            .as_mut()
            .map(|f| f.write_all(bytes).is_ok())
            .unwrap_or(false);
        if !ok {
            self.host.fail(
                id,
                DeviceErrorCode::Internal,
                Some("writing the destination failed".into()),
            );
            return;
        }
        save.written += bytes.len() as u64;
        // Replenish only as bytes reach the destination: the outstanding
        // window never exceeds DOWNLOAD_WINDOW.
        let more = (bytes.len() as u64).min(save.declared.saturating_sub(save.granted));
        if more > 0 {
            let granted = self.host.grant_download(id, more);
            if let Some(DriverOp::Saving(save)) = self.ops.get_mut(&id) {
                save.granted += granted;
            }
        }
    }

    fn commit_download(&mut self, id: u32) {
        let Some(DriverOp::Saving(mut save)) = self.ops.remove(&id) else {
            return;
        };
        let committed = save
            .file
            .take()
            .map(|f| f.sync_all().is_ok())
            .unwrap_or(false)
            && std::fs::rename(&save.temp, &save.dest).is_ok();
        if !committed {
            discard(save);
            self.host.fail(
                id,
                DeviceErrorCode::Internal,
                Some("committing the destination failed".into()),
            );
            return;
        }
        let mut result = Map::new();
        result.insert("bytesWritten".into(), json!(save.written));
        self.host.succeed(id, result, false);
    }

    fn stop_driver(&mut self, id: u32) {
        if self.drop_pick.as_ref().is_some_and(|p| p.id == id) {
            self.drop_pick = None; // the surface closes
            self.ops.remove(&id);
        }
        if let Some(DriverOp::Saving(save)) = self.ops.remove(&id) {
            discard(save);
        }
        self.stop_capture(id);
    }
}

impl Drop for DesktopDevice {
    fn drop(&mut self) {
        for (_, op) in self.ops.drain() {
            if let DriverOp::Saving(save) = op {
                discard(save);
            }
        }
    }
}

/// Failure / cancellation: the partial temporary file is removed.
fn discard(mut save: PendingSave) {
    drop(save.file.take());
    let _ = std::fs::remove_file(&save.temp);
}

/// Dialogs block until the user answers: run them on their own thread so the
/// socket worker keeps renewing leases and applying patches meanwhile.
fn spawn_dialog(f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new()
        .name("hypen-device-dialog".into())
        .spawn(f)
    {
        log::error!("device: cannot spawn the dialog thread: {e}");
    }
}

/// `scheme://host[:port]` of a WebSocket URL — the origin the consent
/// dialogs name.
pub fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return String::new();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    )
}

#[cfg(test)]
mod capture_tests;
#[cfg(test)]
mod tests;
