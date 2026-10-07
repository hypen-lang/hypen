//! Host-owned device UI (RFC 001 §2.6, §5): consent dialogs, the camera
//! capture panel, the Bluetooth chooser, and the always-visible activity
//! indicators with their Stop control.
//!
//! Drivers talk to it through [`DeviceUi`], a small surface API: `show` a
//! [`Surface`] with an action callback, `update` it (camera preview frames,
//! chooser entries, recording state), `close` it. The desktop renderer's
//! implementation is the process-wide [`OverlayHub`] ([`overlay_hub`]),
//! which the window draws as an in-window overlay outside the app's patch
//! tree (see `crate::device::overlay`); tests script their own
//! [`DeviceUi`].
//!
//! Everything a surface shows is host text: the origin comes from the
//! socket URL, labels from the host; nothing server-supplied can restyle,
//! hide or impersonate it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub type SurfaceId = u64;

/// Input protection: an activating control accepts input only this long
/// after it became visible (restarted when the window regains focus or
/// becomes visible again), like the web host's consent dialog.
pub const ARMING_DELAY: Duration = Duration::from_millis(500);

/// How long after the app answered an OS file drag (a files zone's
/// `.onFileDragEnter`) a `file.pick` still counts as "asked during the
/// drag" and gets the drop surface instead of the OS panel.
pub const FILE_DRAG_GRACE: Duration = Duration::from_secs(2);

/// A host consent dialog: "<origin> wants to <operation>" + Continue/Cancel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentPrompt {
    pub origin: String,
    pub capability: String,
    /// Host-defined verb phrase ("record audio from your microphone").
    pub operation: String,
    /// Host-defined detail lines (format, limits).
    pub details: Vec<String>,
}

/// The `file.pick` / `gallery.pick` consent surface shown while files are
/// being dragged over the window: "<origin> wants to <operation>", a drop
/// area ("Drop files here, or Continue to browse") and Cancel / Continue.
/// Releasing the files on the armed drop area is the per-use choice
/// ([`UiAction::Dropped`]); Continue opens the OS open panel instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDropPrompt {
    pub origin: String,
    pub capability: String,
    /// Host-defined verb phrase ("choose files").
    pub operation: String,
    /// Several files may be dropped (`maxCount` > 1).
    pub multiple: bool,
    /// Host-rendered detail lines (accepted types, limits).
    pub details: Vec<String>,
}

/// The capture panel: live preview, Capture (photo) or Record/Stop (video),
/// Cancel. It is the consent gate of `camera.capture`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraPrompt {
    pub origin: String,
    pub video: bool,
    pub max_duration_ms: Option<u64>,
}

/// The Bluetooth chooser: a live, filtered device list + Cancel. It is the
/// gate of `bluetooth.select` and, while open, the visible UI of its scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChooserPrompt {
    pub origin: String,
    /// Host-rendered filter description lines.
    pub filters: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndicatorKind {
    Microphone,
    BluetoothScan,
}

/// A non-modal activity indicator with a Stop control (mic recording, BLE
/// scan), visible for the whole activity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndicatorSpec {
    pub origin: String,
    pub kind: IndicatorKind,
    /// Host-defined activity label.
    pub activity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Surface {
    Consent(ConsentPrompt),
    FileDrop(FileDropPrompt),
    Camera(CameraPrompt),
    Chooser(ChooserPrompt),
    Indicator(IndicatorSpec),
}

impl Surface {
    /// Modal surfaces take all window input while shown.
    pub fn is_modal(&self) -> bool {
        !matches!(self, Surface::Indicator(_))
    }
}

/// What the user (or the window) did with a surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiAction {
    /// Consent: Continue.
    Continue,
    /// Consent: Cancel (a host refusal); camera / chooser: Cancel.
    Cancel,
    /// Escape / window close on a consent dialog: abandonment.
    Dismiss,
    /// Camera: take the photo.
    Capture,
    /// Camera: start recording.
    Record,
    /// Camera recording / indicator: Stop.
    Stop,
    /// Chooser: this device (its opaque id).
    Choose(String),
    /// The window was hidden (minimized) or closed: the surface
    /// can no longer be seen.
    Hidden,
    /// File drop surface: files released on its armed drop area. Local
    /// paths for the driver to read; they never reach the server.
    Dropped(Vec<PathBuf>),
}

/// A decoded preview frame for the capture panel (RGBA8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraPhase {
    /// Opening the camera.
    Starting,
    /// Preview running; Capture / Record armed.
    Live,
    /// Recording since the given instant; Stop visible.
    Recording { since: Instant },
    /// Finishing (encoding a photo / closing the file).
    Busy(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChooserEntry {
    pub id: String,
    pub name: Option<String>,
    pub rssi: i16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceUpdate {
    Preview(PreviewFrame),
    CameraPhase(CameraPhase),
    Devices(Vec<ChooserEntry>),
}

pub type ActionSink = Arc<dyn Fn(UiAction) + Send + Sync>;

/// The host UI the drivers present.
pub trait DeviceUi: Send + Sync + 'static {
    /// UI can be presented on this machine at all (a display exists). The
    /// advertisement rule: capabilities gated by this UI are offered only
    /// when true.
    fn available(&self) -> bool;

    /// A visible window can show a surface right now.
    fn can_present(&self) -> bool;

    /// Show a surface; `on_action` receives its actions (on any thread).
    /// `None` when it cannot be shown (no visible window, or a modal
    /// surface is already up).
    fn show(&self, surface: Surface, on_action: ActionSink) -> Option<SurfaceId>;

    fn update(&self, id: SurfaceId, update: SurfaceUpdate);

    /// Remove a surface. Idempotent.
    fn close(&self, id: SurfaceId);

    /// Files from the OS are being dragged over the window right now (or
    /// the app answered such a drag within [`FILE_DRAG_GRACE`]): a file
    /// pick should offer the drop surface rather than open the OS panel.
    fn file_drag_in_progress(&self) -> bool {
        false
    }
}

/// A UI that can never present (no window): consent-gated capabilities
/// answer `unavailable` (RFC 001 §2.6 "headless hosts").
#[derive(Debug, Default, Clone, Copy)]
pub struct HeadlessUi;

impl DeviceUi for HeadlessUi {
    fn available(&self) -> bool {
        false
    }
    fn can_present(&self) -> bool {
        false
    }
    fn show(&self, _: Surface, _: ActionSink) -> Option<SurfaceId> {
        None
    }
    fn update(&self, _: SurfaceId, _: SurfaceUpdate) {}
    fn close(&self, _: SurfaceId) {}
}

// ---------------------------------------------------------------------------
// The window-backed hub
// ---------------------------------------------------------------------------

/// One live surface as the window sees it.
#[derive(Clone)]
pub struct SurfaceState {
    pub id: SurfaceId,
    pub surface: Surface,
    pub shown_at: Instant,
    /// Activating controls accept input from this instant on.
    pub armed_at: Instant,
    pub phase: CameraPhase,
    pub preview: Option<PreviewFrame>,
    pub devices: Vec<ChooserEntry>,
    pub(crate) sink: ActionSink,
}

impl std::fmt::Debug for SurfaceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfaceState")
            .field("id", &self.id)
            .field("surface", &self.surface)
            .field("phase", &self.phase)
            .field("devices", &self.devices.len())
            .finish()
    }
}

impl SurfaceState {
    pub fn is_armed(&self, now: Instant) -> bool {
        now >= self.armed_at
    }
}

#[derive(Default)]
struct HubState {
    surfaces: BTreeMap<SurfaceId, SurfaceState>,
    generation: u64,
    /// An OS file drag is over the window.
    file_hovering: bool,
    /// When the app was last signalled about an OS file drag (a files
    /// zone's `.onFileDragEnter`).
    file_signal: Option<Instant>,
}

type Waker = Arc<dyn Fn() + Send + Sync>;

/// The desktop window's device UI: drivers post surfaces here from the
/// socket worker; the window draws them over the app, routes input to them
/// and publishes them to assistive tech. One per process (one event loop).
pub struct OverlayHub {
    state: Mutex<HubState>,
    waker: Mutex<Option<Waker>>,
    /// A window is attached (set by `DesktopApp::run`).
    attached: AtomicBool,
    /// The attached window is visible (not minimized; a window covered by
    /// another one still counts as visible).
    visible: AtomicBool,
    next_id: AtomicU64,
    /// Force [`DeviceUi::available`] (tests / embedders with their own
    /// presentation logic); `None` = a display exists.
    available_override: Mutex<Option<bool>>,
    ticker: Condvar,
    ticker_started: AtomicBool,
}

impl std::fmt::Debug for OverlayHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OverlayHub")
            .field("attached", &self.attached.load(Ordering::Relaxed))
            .field("visible", &self.visible.load(Ordering::Relaxed))
            .finish()
    }
}

/// The process-wide hub the renderer window draws.
pub fn overlay_hub() -> Arc<OverlayHub> {
    static HUB: OnceLock<Arc<OverlayHub>> = OnceLock::new();
    Arc::clone(HUB.get_or_init(|| Arc::new(OverlayHub::new())))
}

impl Default for OverlayHub {
    fn default() -> Self {
        Self::new()
    }
}

impl OverlayHub {
    pub fn new() -> Self {
        OverlayHub {
            state: Mutex::new(HubState::default()),
            waker: Mutex::new(None),
            attached: AtomicBool::new(false),
            visible: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            available_override: Mutex::new(None),
            ticker: Condvar::new(),
            ticker_started: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Override [`DeviceUi::available`].
    pub fn set_available(&self, available: Option<bool>) {
        *self
            .available_override
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = available;
    }

    /// The window attaches (its event-loop waker) and becomes visible.
    pub fn attach_window(self: &Arc<Self>, waker: Waker) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(waker);
        self.attached.store(true, Ordering::SeqCst);
        self.visible.store(true, Ordering::SeqCst);
        self.start_ticker();
        self.wake();
    }

    /// The window went away: every surface is hidden for good.
    pub fn detach_window(&self) {
        self.attached.store(false, Ordering::SeqCst);
        self.visible.store(false, Ordering::SeqCst);
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.notify_hidden();
    }

    /// The window was minimized (`false`) or shown again.
    /// Hiding tells every surface ([`UiAction::Hidden`]); showing re-arms
    /// the activating controls (input protection restarts).
    pub fn set_visible(&self, visible: bool) {
        let was = self.visible.swap(visible, Ordering::SeqCst);
        if was == visible {
            return;
        }
        if visible {
            self.rearm();
        } else {
            self.notify_hidden();
        }
    }

    /// Restart input protection on every surface (window regained focus /
    /// visibility): a click or key meant for something else cannot land on
    /// a control that just appeared under it.
    pub fn rearm(&self) {
        let now = Instant::now();
        let mut st = self.lock();
        for s in st.surfaces.values_mut() {
            s.armed_at = s.armed_at.max(now + ARMING_DELAY);
        }
        st.generation += 1;
        drop(st);
        self.wake();
    }

    fn notify_hidden(&self) {
        let sinks: Vec<ActionSink> = self
            .lock()
            .surfaces
            .values()
            .map(|s| Arc::clone(&s.sink))
            .collect();
        for sink in sinks {
            sink(UiAction::Hidden);
        }
    }

    /// The window: an OS file drag entered (`true`) or left / was dropped
    /// (`false`). A drop also ends the grace window — the files were
    /// released somewhere, so there is no drag left to catch.
    pub fn set_file_hovering(&self, hovering: bool, dropped: bool) {
        let mut st = self.lock();
        st.file_hovering = hovering;
        if dropped {
            st.file_signal = None;
        }
    }

    /// The window dispatched a files zone's `.onFileDragEnter`.
    pub fn note_file_drag_signal(&self) {
        self.lock().file_signal = Some(Instant::now());
    }

    /// Snapshot for the window: live surfaces (modal last) and the change
    /// generation.
    pub fn snapshot(&self) -> (u64, Vec<SurfaceState>) {
        let st = self.lock();
        (st.generation, st.surfaces.values().cloned().collect())
    }

    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// Whether anything is shown (the window checks before routing input).
    pub fn is_empty(&self) -> bool {
        self.lock().surfaces.is_empty()
    }

    /// Deliver a user action to a surface's driver (from the window thread;
    /// the hub lock is not held while the callback runs).
    pub fn activate(&self, id: SurfaceId, action: UiAction) {
        let sink = self.lock().surfaces.get(&id).map(|s| Arc::clone(&s.sink));
        if let Some(sink) = sink {
            sink(action);
        }
    }

    fn wake(&self) {
        let waker = self.waker.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(w) = waker {
            w();
        }
        self.ticker.notify_all();
    }

    fn needs_ticks(&self) -> bool {
        let now = Instant::now();
        self.lock().surfaces.values().any(|s| {
            !s.is_armed(now)
                || matches!(s.surface, Surface::Indicator(_))
                || matches!(s.phase, CameraPhase::Recording { .. })
        })
    }

    /// Elapsed-time labels and input protection change with time alone:
    /// while such a surface is up, wake the window a few times a second.
    fn start_ticker(self: &Arc<Self>) {
        if self.ticker_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("hypen-device-ui-ticker".into())
            .spawn(move || loop {
                let Some(hub) = weak.upgrade() else {
                    return;
                };
                if hub.needs_ticks() {
                    let waker = hub.waker.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if let Some(w) = waker {
                        w();
                    }
                    drop(hub);
                    std::thread::sleep(Duration::from_millis(250));
                } else {
                    let guard = hub.lock();
                    let _ = hub
                        .ticker
                        .wait_timeout(guard, Duration::from_secs(5))
                        .map(|(g, _)| drop(g));
                }
            });
        if let Err(e) = spawned {
            log::warn!("device: cannot start the UI ticker: {e}");
        }
    }
}

impl DeviceUi for OverlayHub {
    fn available(&self) -> bool {
        if let Some(v) = *self
            .available_override
            .lock()
            .unwrap_or_else(|e| e.into_inner())
        {
            return v;
        }
        super::dialogs::display_present()
    }

    fn can_present(&self) -> bool {
        self.attached.load(Ordering::SeqCst) && self.visible.load(Ordering::SeqCst)
    }

    fn show(&self, surface: Surface, on_action: ActionSink) -> Option<SurfaceId> {
        if !self.can_present() {
            return None;
        }
        let now = Instant::now();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        {
            let mut st = self.lock();
            if surface.is_modal() && st.surfaces.values().any(|s| s.surface.is_modal()) {
                return None;
            }
            st.surfaces.insert(
                id,
                SurfaceState {
                    id,
                    surface,
                    shown_at: now,
                    armed_at: now + ARMING_DELAY,
                    phase: CameraPhase::Starting,
                    preview: None,
                    devices: Vec::new(),
                    sink: on_action,
                },
            );
            st.generation += 1;
        }
        self.wake();
        Some(id)
    }

    fn update(&self, id: SurfaceId, update: SurfaceUpdate) {
        {
            let mut st = self.lock();
            let Some(s) = st.surfaces.get_mut(&id) else {
                return;
            };
            match update {
                SurfaceUpdate::Preview(frame) => s.preview = Some(frame),
                SurfaceUpdate::CameraPhase(phase) => {
                    // Recording starts behind a fresh arming window: the
                    // Stop that replaced Record under the pointer must not
                    // take the same click.
                    if matches!(phase, CameraPhase::Recording { .. }) {
                        s.armed_at = Instant::now() + ARMING_DELAY;
                    }
                    s.phase = phase;
                }
                SurfaceUpdate::Devices(devices) => s.devices = devices,
            }
            st.generation += 1;
        }
        self.wake();
    }

    fn file_drag_in_progress(&self) -> bool {
        let st = self.lock();
        st.file_hovering
            || st
                .file_signal
                .is_some_and(|t| t.elapsed() <= FILE_DRAG_GRACE)
    }

    fn close(&self, id: SurfaceId) {
        let removed = {
            let mut st = self.lock();
            let removed = st.surfaces.remove(&id).is_some();
            if removed {
                st.generation += 1;
            }
            removed
        };
        if removed {
            self.wake();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn recorder() -> (ActionSink, Arc<StdMutex<Vec<UiAction>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = Arc::clone(&seen);
        (Arc::new(move |a| s.lock().unwrap().push(a)), seen)
    }

    fn consent() -> Surface {
        Surface::Consent(ConsentPrompt {
            origin: "wss://app.example".into(),
            capability: "mic.record".into(),
            operation: "record audio".into(),
            details: vec![],
        })
    }

    #[test]
    fn nothing_presents_without_a_visible_window() {
        let hub = Arc::new(OverlayHub::new());
        let (sink, _) = recorder();
        assert!(hub.show(consent(), sink.clone()).is_none());
        hub.attach_window(Arc::new(|| {}));
        let id = hub.show(consent(), sink.clone()).expect("shown");
        // One modal at a time; indicators stack beside it.
        assert!(hub.show(consent(), sink.clone()).is_none());
        let ind = Surface::Indicator(IndicatorSpec {
            origin: "o".into(),
            kind: IndicatorKind::Microphone,
            activity: "Recording".into(),
        });
        assert!(hub.show(ind, sink.clone()).is_some());
        hub.close(id);
        assert!(hub.show(consent(), sink).is_some());
    }

    #[test]
    fn hiding_the_window_tells_every_surface_and_showing_rearms() {
        let hub = Arc::new(OverlayHub::new());
        hub.attach_window(Arc::new(|| {}));
        let (sink, seen) = recorder();
        let id = hub.show(consent(), sink).unwrap();
        let armed_before = hub.snapshot().1[0].armed_at;
        hub.set_visible(false);
        assert_eq!(*seen.lock().unwrap(), [UiAction::Hidden]);
        assert!(!hub.can_present());
        std::thread::sleep(Duration::from_millis(5));
        hub.set_visible(true);
        let armed_after = hub.snapshot().1[0].armed_at;
        assert!(armed_after > armed_before, "input protection restarted");
        hub.activate(id, UiAction::Continue);
        assert_eq!(seen.lock().unwrap().last(), Some(&UiAction::Continue));
        hub.detach_window();
        assert_eq!(seen.lock().unwrap().last(), Some(&UiAction::Hidden));
    }

    #[test]
    fn updates_change_the_generation_and_closed_surfaces_ignore_them() {
        let hub = Arc::new(OverlayHub::new());
        hub.attach_window(Arc::new(|| {}));
        let (sink, _) = recorder();
        let cam = Surface::Camera(CameraPrompt {
            origin: "o".into(),
            video: true,
            max_duration_ms: None,
        });
        let id = hub.show(cam, sink).unwrap();
        let g0 = hub.generation();
        hub.update(id, SurfaceUpdate::CameraPhase(CameraPhase::Live));
        assert!(hub.generation() > g0);
        assert_eq!(hub.snapshot().1[0].phase, CameraPhase::Live);
        hub.close(id);
        let g1 = hub.generation();
        hub.update(id, SurfaceUpdate::CameraPhase(CameraPhase::Starting));
        assert_eq!(hub.generation(), g1);
        assert!(hub.is_empty());
    }
}
