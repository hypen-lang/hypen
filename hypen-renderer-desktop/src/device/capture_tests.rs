//! Capture-driver tests: `camera.capture`, `mic.record`, `bluetooth.scan`,
//! `bluetooth.select`, `permission.query` / `permission.request`, driven
//! through the real [`DesktopDevice`] with fake hardware and a scripted
//! host UI (this machine has no camera, microphone, adapter or display).
//!
//! Every wire message the host produces goes through the strict decoder;
//! uploads are reassembled from their binary frames (contiguous `seq` from
//! 0, channel 0) and checked against the terminal's byte count and
//! SHA-256, the way a server verifies them.

use super::hw::*;
use super::ui::*;
use super::*;
use hypen_engine::serialize::device::{DeviceMessage, FrameHeader};
use std::collections::HashMap as Map2;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

// ---------------------------------------------------------------------------
// fake host UI
// ---------------------------------------------------------------------------

struct Shown {
    surface: Surface,
    sink: ActionSink,
    updates: Vec<SurfaceUpdate>,
    open: bool,
}

#[derive(Default)]
struct FakeUi {
    shown: Mutex<Map2<SurfaceId, Shown>>,
    next: AtomicUsize,
    hidden: AtomicBool,
}

impl DeviceUi for FakeUi {
    fn available(&self) -> bool {
        true
    }
    fn can_present(&self) -> bool {
        !self.hidden.load(Ordering::SeqCst)
    }
    fn show(&self, surface: Surface, on_action: ActionSink) -> Option<SurfaceId> {
        if !self.can_present() {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) as SurfaceId + 1;
        self.shown.lock().unwrap().insert(
            id,
            Shown {
                surface,
                sink: on_action,
                updates: Vec::new(),
                open: true,
            },
        );
        Some(id)
    }
    fn update(&self, id: SurfaceId, update: SurfaceUpdate) {
        if let Some(s) = self.shown.lock().unwrap().get_mut(&id) {
            if s.open {
                s.updates.push(update);
            }
        }
    }
    fn close(&self, id: SurfaceId) {
        if let Some(s) = self.shown.lock().unwrap().get_mut(&id) {
            s.open = false;
        }
    }
}

impl FakeUi {
    fn open(&self) -> Vec<(SurfaceId, Surface)> {
        let mut v: Vec<_> = self
            .shown
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.open)
            .map(|(id, s)| (*id, s.surface.clone()))
            .collect();
        v.sort_by_key(|(id, _)| *id);
        v
    }
    fn find(&self, pred: impl Fn(&Surface) -> bool) -> Option<SurfaceId> {
        self.open()
            .into_iter()
            .find(|(_, s)| pred(s))
            .map(|(id, _)| id)
    }
    fn consent(&self) -> Option<SurfaceId> {
        self.find(|s| matches!(s, Surface::Consent(_)))
    }
    fn camera(&self) -> Option<SurfaceId> {
        self.find(|s| matches!(s, Surface::Camera(_)))
    }
    fn chooser(&self) -> Option<SurfaceId> {
        self.find(|s| matches!(s, Surface::Chooser(_)))
    }
    fn indicator(&self, kind: IndicatorKind) -> Option<SurfaceId> {
        self.find(|s| matches!(s, Surface::Indicator(i) if i.kind == kind))
    }
    fn act(&self, id: SurfaceId, action: UiAction) {
        let sink = self
            .shown
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| Arc::clone(&s.sink));
        sink.expect("surface")(action);
    }
    fn updates(&self, id: SurfaceId) -> Vec<SurfaceUpdate> {
        self.shown
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.updates.clone())
            .unwrap_or_default()
    }
    fn phase(&self, id: SurfaceId) -> Option<CameraPhase> {
        self.updates(id).into_iter().rev().find_map(|u| match u {
            SurfaceUpdate::CameraPhase(p) => Some(p),
            _ => None,
        })
    }
    fn devices(&self, id: SurfaceId) -> Vec<ChooserEntry> {
        self.updates(id)
            .into_iter()
            .rev()
            .find_map(|u| match u {
                SurfaceUpdate::Devices(d) => Some(d),
                _ => None,
            })
            .unwrap_or_default()
    }
    fn ever_shown(&self) -> usize {
        self.shown.lock().unwrap().len()
    }
}

// ---------------------------------------------------------------------------
// fake hardware
// ---------------------------------------------------------------------------

/// Checks the RFC 001 §5 rule on every hardware start / stop: the host UI
/// that makes the activity visible (camera panel, recording / scanning
/// indicator, chooser) must be on screen whenever the hardware runs. A
/// start without it, or a release after it disappeared, is counted.
#[derive(Default)]
struct Oracle {
    ui: Mutex<Option<Arc<FakeUi>>>,
    uncovered: AtomicUsize,
}

impl Oracle {
    fn check(&self, visible: impl Fn(&FakeUi) -> bool) {
        if let Some(ui) = self.ui.lock().unwrap().as_ref() {
            if !visible(ui) {
                self.uncovered.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Default)]
struct FakeCamera {
    oracle: Arc<Oracle>,
    cameras: AtomicUsize,
    open_error: Mutex<Option<HwError>>,
    live: Arc<AtomicUsize>,
    opened: AtomicUsize,
}

struct FakeSource {
    n: u64,
    live: Arc<AtomicUsize>,
    oracle: Arc<Oracle>,
}

impl Drop for FakeSource {
    fn drop(&mut self) {
        self.oracle.check(|ui| ui.camera().is_some());
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl CameraSource for FakeSource {
    fn next_frame(&mut self) -> Result<RgbFrame, HwError> {
        std::thread::sleep(Duration::from_millis(2));
        let (w, h) = (64u32, 48u32);
        let shade = (self.n * 7 % 255) as u8;
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(&[(x * 4) as u8, (y * 5) as u8, shade]);
            }
        }
        let at = Duration::from_millis(self.n * 33);
        self.n += 1;
        Ok(RgbFrame {
            width: w,
            height: h,
            rgb,
            at,
        })
    }
}

impl CameraBackend for FakeCamera {
    fn camera_count(&self) -> Result<usize, HwError> {
        Ok(self.cameras.load(Ordering::SeqCst))
    }
    fn open(&self, _: Option<Facing>) -> Result<Box<dyn CameraSource>, HwError> {
        if let Some(e) = self.open_error.lock().unwrap().clone() {
            return Err(e);
        }
        self.oracle.check(|ui| ui.camera().is_some());
        self.opened.fetch_add(1, Ordering::SeqCst);
        self.live.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeSource {
            n: 0,
            live: Arc::clone(&self.live),
            oracle: Arc::clone(&self.oracle),
        }))
    }
}

#[derive(Default)]
struct FakeMic {
    oracle: Arc<Oracle>,
    absent: AtomicBool,
    start_error: Mutex<Option<HwError>>,
    live: Arc<AtomicUsize>,
    started: AtomicUsize,
}

struct FakeMicStream {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    live: Arc<AtomicUsize>,
    oracle: Arc<Oracle>,
}

impl MicStream for FakeMicStream {}

impl Drop for FakeMicStream {
    fn drop(&mut self) {
        self.oracle
            .check(|ui| ui.indicator(IndicatorKind::Microphone).is_some());
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl MicBackend for FakeMic {
    fn has_input(&self) -> bool {
        !self.absent.load(Ordering::SeqCst)
    }
    fn start(
        &self,
        mut sink: AudioSink,
        _on_error: AudioErrorSink,
    ) -> Result<Box<dyn MicStream>, HwError> {
        if let Some(e) = self.start_error.lock().unwrap().clone() {
            return Err(e);
        }
        self.oracle
            .check(|ui| ui.indicator(IndicatorKind::Microphone).is_some());
        self.started.fetch_add(1, Ordering::SeqCst);
        self.live.fetch_add(1, Ordering::SeqCst);
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = Arc::clone(&stop);
        // 48 kHz stereo float, ~10x real time.
        let thread = std::thread::spawn(move || {
            let mut t = 0u64;
            while !s2.load(Ordering::SeqCst) {
                let mut samples = Vec::with_capacity(960);
                for _ in 0..480 {
                    let v = ((t as f32) * 0.05).sin() * 0.5;
                    samples.push(v);
                    samples.push(-v);
                    t += 1;
                }
                sink(AudioBlock {
                    sample_rate: 48_000,
                    channels: 2,
                    samples,
                });
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        Ok(Box::new(FakeMicStream {
            stop,
            thread: Some(thread),
            live: Arc::clone(&self.live),
            oracle: Arc::clone(&self.oracle),
        }))
    }
}

#[derive(Default)]
struct FakeBt {
    oracle: Arc<Oracle>,
    adapter: Mutex<Option<HwError>>,
    ads: Mutex<Vec<Advertisement>>,
    live: Arc<AtomicUsize>,
    scans: AtomicUsize,
}

struct FakeScan {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    live: Arc<AtomicUsize>,
    oracle: Arc<Oracle>,
}

fn scan_visible(ui: &FakeUi) -> bool {
    ui.indicator(IndicatorKind::BluetoothScan).is_some() || ui.chooser().is_some()
}

impl ScanHandle for FakeScan {}

impl Drop for FakeScan {
    fn drop(&mut self) {
        self.oracle.check(scan_visible);
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl BluetoothBackend for FakeBt {
    fn check_adapter(&self) -> Result<(), HwError> {
        match self.adapter.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn scan(&self, mut sink: ScanSink) -> Result<Box<dyn ScanHandle>, HwError> {
        self.oracle.check(scan_visible);
        self.scans.fetch_add(1, Ordering::SeqCst);
        self.live.fetch_add(1, Ordering::SeqCst);
        let ads = self.ads.lock().unwrap().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let mut round = 0i16;
            while !s2.load(Ordering::SeqCst) {
                for ad in &ads {
                    let mut ad = ad.clone();
                    // RSSI jumps each round so coalescing re-reports.
                    ad.rssi -= (round % 2) * 10;
                    sink(ScanEvent::Advertisement(ad));
                }
                round += 1;
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        Ok(Box::new(FakeScan {
            stop,
            thread: Some(thread),
            live: Arc::clone(&self.live),
            oracle: Arc::clone(&self.oracle),
        }))
    }
}

#[derive(Default)]
struct FakePerms {
    states: Mutex<Map2<Permission, PermissionState>>,
    answer: Mutex<Option<PermissionState>>,
    asked: AtomicUsize,
}

impl PermissionBackend for FakePerms {
    fn status(&self, p: Permission) -> PermissionState {
        self.states
            .lock()
            .unwrap()
            .get(&p)
            .cloned()
            .unwrap_or(PermissionState::Granted)
    }
    fn request(&self, p: Permission) -> Result<PermissionState, HwError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let a = self
            .answer
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(PermissionState::Granted);
        self.states.lock().unwrap().insert(p, a.clone());
        Ok(a)
    }
}

struct Fakes {
    oracle: Arc<Oracle>,
    ui: Arc<FakeUi>,
    camera: Arc<FakeCamera>,
    mic: Arc<FakeMic>,
    bt: Arc<FakeBt>,
    perms: Arc<FakePerms>,
}

impl Fakes {
    fn new() -> Self {
        let ui = Arc::new(FakeUi::default());
        let oracle = Arc::new(Oracle::default());
        *oracle.ui.lock().unwrap() = Some(Arc::clone(&ui));
        let camera = Arc::new(FakeCamera {
            oracle: Arc::clone(&oracle),
            ..Default::default()
        });
        camera.cameras.store(1, Ordering::SeqCst);
        Fakes {
            ui,
            camera,
            mic: Arc::new(FakeMic {
                oracle: Arc::clone(&oracle),
                ..Default::default()
            }),
            bt: Arc::new(FakeBt {
                oracle: Arc::clone(&oracle),
                ..Default::default()
            }),
            perms: Arc::new(FakePerms::default()),
            oracle,
        }
    }
    fn hardware(&self) -> Hardware {
        Hardware {
            camera: Some(self.camera.clone()),
            mic: Some(self.mic.clone()),
            bluetooth: Some(self.bt.clone()),
            permissions: Some(self.perms.clone()),
        }
    }
    fn config(&self) -> DeviceConfig {
        DeviceConfig::with_dialogs(Arc::new(NoDialogs))
            .with_capture(self.ui.clone(), self.hardware())
    }
}

struct NoDialogs;

impl FileDialogs for NoDialogs {
    fn pick_files(&self, _: &PickDialog) -> Result<Option<Vec<PathBuf>>, DialogUnavailable> {
        Ok(None)
    }
    fn save_file(&self, _: &SaveDialog) -> Result<Option<PathBuf>, DialogUnavailable> {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// the rig: a DesktopDevice on a scripted connection with a granting server
// ---------------------------------------------------------------------------

fn ack_for(host: &DeviceHost) -> String {
    let caps: Vec<Value> = host
        .advertisement()
        .capabilities
        .iter()
        .map(|o| json!({"name": o.name, "version": o.versions[o.versions.len() - 1]}))
        .collect();
    json!({"protocolVersion": 1, "binary": true, "capabilities": caps}).to_string()
}

fn core_request(id: u32) -> String {
    json!({"type":"deviceRequest","id":id,"capability":"core.capabilities","version":1,
           "owner":{"connection":true},"lifetime":"connection","timeoutMs":86_400_000,
           "initialCredit":8,"params":{}})
    .to_string()
}

fn request(id: u32, capability: &str, credit: u64, params: Value) -> String {
    let timeout = hypen_engine::serialize::device::find_revision(capability, 1)
        .map(|r| r.max_timeout_ms.min(300_000))
        .unwrap_or(300_000);
    json!({"type":"deviceRequest","id":id,"capability":capability,"version":1,
           "owner":{"moduleInstanceId":"app@s#1","activationId":1},"lifetime":"activation",
           "timeoutMs":timeout,"initialCredit":credit,"params":params})
    .to_string()
}

fn control(id: u32, control: Value) -> String {
    json!({"type":"deviceEvent","id":id,"control":control}).to_string()
}

struct Rig {
    device: DesktopDevice,
    rx: mpsc::UnboundedReceiver<DriverMsg>,
    f: Fakes,
    texts: Vec<Value>,
    frames: Vec<(FrameHeader, Vec<u8>)>,
    /// Grant back every byte / event received, like a consuming server.
    auto_grant: bool,
}

const WAIT: Duration = Duration::from_secs(20);

impl Rig {
    fn new(f: Fakes) -> Self {
        Self::with_origin(f, "ws://localhost:3000")
    }

    fn with_origin(f: Fakes, origin: &str) -> Self {
        let config = f.config();
        Self::with_config(f, config, origin)
    }

    fn with_config(f: Fakes, config: DeviceConfig, origin: &str) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut device = DesktopDevice::new(&config, tx);
        device.attach(origin.into());
        let ack = ack_for(device.host());
        device.on_ack(Some(&ack));
        device.on_text(&core_request(1));
        let _ = device.drain();
        Rig {
            device,
            rx,
            f,
            texts: Vec::new(),
            frames: Vec::new(),
            auto_grant: true,
        }
    }

    fn send(&mut self, text: &str) {
        self.device.on_text(text);
        self.flush();
    }

    fn flush(&mut self) {
        loop {
            let mut grants: Vec<(u32, u64)> = Vec::new();
            let mut any = false;
            loop {
                let outs = self.device.drain();
                if outs.is_empty() && !self.device.has_ready_work() {
                    break;
                }
                for o in outs {
                    any = true;
                    match o {
                        WireOut::Text(t) => {
                            DeviceMessage::decode(&t)
                                .unwrap_or_else(|e| panic!("invalid output {t}: {e}"));
                            let v: Value = serde_json::from_str(&t).unwrap();
                            if self.auto_grant && v["event"]["device"].is_object() {
                                grants.push((v["id"].as_u64().unwrap() as u32, 1));
                            }
                            self.texts.push(v);
                        }
                        WireOut::Binary(b) => {
                            let (h, p) = FrameHeader::decode(&b).unwrap();
                            if self.auto_grant {
                                grants.push((h.request_id, p.len() as u64));
                            }
                            self.frames.push((h, p.to_vec()));
                        }
                        WireOut::Close(c, r) => panic!("unexpected close {c} {r}"),
                    }
                }
            }
            if grants.is_empty() {
                if !any {
                    return;
                }
                continue;
            }
            for (id, n) in grants {
                if self.device.host().is_live(id) {
                    self.device.on_text(&control(id, json!({ "grant": n })));
                }
            }
        }
    }

    fn pump(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            self.device.on_driver(msg);
        }
        self.flush();
    }

    fn wait(&mut self, what: &str, cond: impl Fn(&Rig) -> bool) {
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            self.pump();
            if cond(self) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}; texts: {:#?}",
                self.texts
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn terminal(&self, id: u32) -> Option<&Value> {
        self.texts
            .iter()
            .find(|m| m["type"] == "deviceResponse" && m["id"] == id)
    }

    fn wait_terminal(&mut self, id: u32) -> Value {
        self.wait(&format!("terminal of {id}"), |r| r.terminal(id).is_some());
        let t = self.terminal(id).unwrap().clone();
        // Exactly one terminal, ever.
        assert_eq!(
            self.texts
                .iter()
                .filter(|m| m["type"] == "deviceResponse" && m["id"] == id)
                .count(),
            1
        );
        t
    }

    fn error(&mut self, id: u32) -> (String, String) {
        let t = self.wait_terminal(id);
        (
            t["error"]["code"].as_str().unwrap_or("-").to_string(),
            t["error"]["platformDetail"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        )
    }

    fn events(&self, id: u32) -> Vec<Value> {
        self.texts
            .iter()
            .filter(|m| m["type"] == "deviceEvent" && m["id"] == id && m.get("event").is_some())
            .map(|m| m["event"].clone())
            .collect()
    }

    fn progress(&self, id: u32) -> Vec<String> {
        self.events(id)
            .iter()
            .filter(|e| e["kind"] == "progress")
            .map(|e| e["state"].as_str().unwrap().to_string())
            .collect()
    }

    /// The upload of `id`, reassembled and checked like a server would.
    fn upload(&self, id: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (seq, (h, p)) in self
            .frames
            .iter()
            .filter(|(h, _)| h.request_id == id)
            .enumerate()
        {
            assert_eq!(h.channel, 0);
            assert_eq!(h.seq as usize, seq, "contiguous seq");
            assert!(!p.is_empty() && p.len() <= 64 * 1024);
            bytes.extend_from_slice(p);
        }
        bytes
    }

    fn status(&self, id: u32) -> Option<capture::CaptureStatus> {
        self.device.capture_status(id)
    }
}

impl Drop for Rig {
    /// Every test ends with a socket reset and the visibility check: no
    /// hardware ran without its host UI on screen, and everything is
    /// released.
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        self.device.detach();
        let deadline = std::time::Instant::now() + WAIT;
        while self.f.camera.live.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            self.f.camera.live.load(Ordering::SeqCst),
            0,
            "camera released"
        );
        assert_eq!(
            self.f.mic.live.load(Ordering::SeqCst),
            0,
            "microphone released"
        );
        assert_eq!(self.f.bt.live.load(Ordering::SeqCst), 0, "scan stopped");
        assert!(self.f.ui.open().is_empty(), "host UI closed");
        assert_eq!(
            self.f.oracle.uncovered.load(Ordering::SeqCst),
            0,
            "hardware ran while its host UI was not on screen"
        );
    }
}

fn sha(bytes: &[u8]) -> String {
    hypen_engine::device::sha256_hex(bytes)
}

fn blob_start(rig: &Rig, id: u32) -> Value {
    rig.events(id)
        .into_iter()
        .find(|e| e["kind"] == "blobStart")
        .expect("blobStart")
}

// ---------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------

#[test]
fn capture_capabilities_are_advertised_only_with_a_backend_and_a_ui() {
    let f = Fakes::new();
    let all = f.config().advertised();
    for c in [
        "camera.capture",
        "mic.record",
        "bluetooth.scan",
        "bluetooth.select",
        "permission.query",
        "permission.request",
    ] {
        assert!(all.contains(&c), "{c} in {all:?}");
    }
    // A backend compiled out (feature off) is not advertised.
    let mut hw = f.hardware();
    hw.camera = None;
    hw.bluetooth = None;
    let partial = DeviceConfig::with_dialogs(Arc::new(NoDialogs)).with_capture(f.ui.clone(), hw);
    let names = partial.advertised();
    assert!(!names.contains(&"camera.capture") && !names.contains(&"bluetooth.scan"));
    assert!(names.contains(&"mic.record"));
    // Without a display there is no host UI to gate anything.
    let headless = DeviceConfig::with_dialogs(Arc::new(NoDialogs))
        .with_capture(Arc::new(HeadlessUi), f.hardware());
    assert!(!headless
        .advertised()
        .iter()
        .any(|c| c.starts_with("camera") || c.starts_with("mic")));
    // The file-dialog-only host keeps the old advertisement exactly.
    assert_eq!(
        DeviceConfig::with_dialogs(Arc::new(NoDialogs)).advertised(),
        ["file.pick", "gallery.pick", "file.save"]
    );
}

#[test]
fn hardware_native_matches_the_compiled_features() {
    let hw = Hardware::native();
    assert_eq!(hw.camera.is_some(), cfg!(feature = "camera"));
    assert_eq!(hw.mic.is_some(), cfg!(feature = "mic"));
    assert_eq!(hw.bluetooth.is_some(), cfg!(feature = "bluetooth"));
    assert!(hw.permissions.is_some());
}

// ---------------------------------------------------------------------------
// camera.capture
// ---------------------------------------------------------------------------

fn wait_live_camera(rig: &mut Rig) -> SurfaceId {
    rig.wait("camera panel live", |r| {
        r.f.ui
            .camera()
            .is_some_and(|s| r.f.ui.phase(s) == Some(CameraPhase::Live))
    });
    rig.f.ui.camera().unwrap()
}

#[test]
fn camera_photo_capture_uploads_one_declared_jpeg() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        4_194_304,
        json!({"mode":"photo"}),
    ));
    let panel = wait_live_camera(&mut rig);
    assert_eq!(rig.progress(2), ["pendingConsent"]);
    // Nothing is captured or sent before the user acts in the panel.
    assert!(rig.frames.is_empty());
    rig.wait("a preview frame", |r| {
        r.f.ui
            .updates(panel)
            .iter()
            .any(|u| matches!(u, SurfaceUpdate::Preview(_)))
    });
    rig.f.ui.act(panel, UiAction::Capture);
    let t = rig.wait_terminal(2);
    let jpeg = rig.upload(2);
    assert_eq!(&jpeg[..3], &[0xff, 0xd8, 0xff], "a JPEG");
    let start = blob_start(&rig, 2);
    assert_eq!(start["contentType"], "image/jpeg");
    assert_eq!(
        start["bytes"],
        jpeg.len(),
        "a finished photo declares its size"
    );
    assert_eq!(
        t["result"],
        json!({"items":[{"channel":0,"contentType":"image/jpeg","bytes":jpeg.len(),"sha256":sha(&jpeg)}]})
    );
    assert_eq!(rig.progress(2), ["pendingConsent", "running"]);
    rig.wait("camera released", |r| {
        r.f.camera.live.load(Ordering::SeqCst) == 0
    });
    rig.wait("the panel closed", |r| r.f.ui.camera().is_none());
}

#[test]
fn camera_cancel_is_cancelled_uploads_nothing_and_cools_down() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    let panel = wait_live_camera(&mut rig);
    rig.f.ui.act(panel, UiAction::Cancel);
    assert_eq!(
        rig.error(2),
        ("cancelled".into(), "capture-dismissed".into())
    );
    assert!(rig.frames.is_empty());
    // The panel goes once the camera thread has released the camera.
    rig.wait("camera released", |r| {
        r.f.camera.live.load(Ordering::SeqCst) == 0
    });
    rig.wait("panel closed", |r| r.f.ui.camera().is_none());
    // A dismissal cools the capability down briefly (no prompt spam).
    rig.send(&request(
        3,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(3), ("throttled".into(), "cooldown".into()));
}

#[cfg(feature = "camera")]
#[test]
fn camera_video_streams_an_undeclared_fragmented_mp4_until_stop() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        4_194_304,
        json!({"mode":"video"}),
    ));
    let panel = wait_live_camera(&mut rig);
    rig.f.ui.act(panel, UiAction::Record);
    rig.wait("recording", |r| {
        r.f.ui
            .phase(panel)
            .is_some_and(|p| matches!(p, CameraPhase::Recording { .. }))
    });
    rig.wait("video bytes", |r| {
        r.frames.iter().map(|(_, p)| p.len()).sum::<usize>() > 2_000
    });
    // The panel (with REC + Stop) is up for as long as the camera records.
    assert!(rig.f.ui.camera().is_some());
    assert_eq!(rig.f.camera.live.load(Ordering::SeqCst), 1);
    rig.f.ui.act(panel, UiAction::Stop);
    let t = rig.wait_terminal(2);
    let video = rig.upload(2);
    let start = blob_start(&rig, 2);
    assert_eq!(start["contentType"], "video/mp4");
    assert!(
        start.get("bytes").is_none(),
        "a live recording does not declare its size"
    );
    assert_eq!(t["result"]["items"][0]["bytes"], video.len());
    assert_eq!(t["result"]["items"][0]["sha256"], sha(&video));
    let boxes = mp4::top_level_boxes(&video).expect("a well-formed ISO BMFF stream");
    assert_eq!(&boxes[0].0, b"ftyp");
    assert_eq!(&boxes[1].0, b"moov");
    assert!(boxes.iter().any(|b| &b.0 == b"moof"));
    rig.wait("camera released", |r| {
        r.f.camera.live.load(Ordering::SeqCst) == 0
    });
    rig.wait("the panel closes when the recording ends", |r| {
        r.f.ui.camera().is_none()
    });
}

#[cfg(feature = "camera")]
#[test]
fn camera_video_max_duration_ends_the_recording_normally() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        4_194_304,
        json!({"mode":"video","maxDurationMs":500}),
    ));
    let panel = wait_live_camera(&mut rig);
    rig.f.ui.act(panel, UiAction::Record);
    let t = rig.wait_terminal(2);
    assert!(t.get("result").is_some(), "{t}");
    let video = rig.upload(2);
    assert_eq!(t["result"]["items"][0]["sha256"], sha(&video));
    rig.wait("panel closed", |r| r.f.ui.camera().is_none());
}

#[cfg(feature = "camera")]
#[test]
fn camera_cancel_mid_recording_discards_it() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        4_194_304,
        json!({"mode":"video"}),
    ));
    let panel = wait_live_camera(&mut rig);
    rig.f.ui.act(panel, UiAction::Record);
    rig.wait("video bytes", |r| !r.frames.is_empty());
    rig.f.ui.act(panel, UiAction::Cancel);
    assert_eq!(rig.error(2).0, "cancelled");
    rig.wait("camera released", |r| {
        r.f.camera.live.load(Ordering::SeqCst) == 0
    });
    rig.wait("panel closed", |r| r.f.ui.camera().is_none());
}

#[cfg(feature = "camera")]
#[test]
fn server_cancel_mid_recording_releases_camera_and_panel() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        4_194_304,
        json!({"mode":"video"}),
    ));
    let panel = wait_live_camera(&mut rig);
    rig.f.ui.act(panel, UiAction::Record);
    rig.wait("video bytes", |r| !r.frames.is_empty());
    rig.send(&control(2, json!({"cancel": true})));
    assert_eq!(rig.error(2).0, "cancelled");
    rig.wait("camera released", |r| {
        r.f.camera.live.load(Ordering::SeqCst) == 0
    });
    rig.wait("the panel closes with the request", |r| {
        r.f.ui.camera().is_none()
    });
    // Late encoder output for the retired id sends nothing.
    let n = rig.frames.len();
    std::thread::sleep(Duration::from_millis(30));
    rig.pump();
    assert_eq!(rig.frames.len(), n);
}

/// Without the `camera` feature there is no H.264 encoder: video is
/// refused `unsupported` (photos still work behind a camera backend).
#[cfg(not(feature = "camera"))]
#[test]
fn video_is_unsupported_without_the_encoder() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"video"}),
    ));
    assert_eq!(
        rig.error(2),
        ("unsupported".into(), "no-video-encoder".into())
    );
    assert_eq!(rig.f.ui.ever_shown(), 0);
}

#[test]
fn camera_without_hardware_or_permission_fails_before_any_ui() {
    let f = Fakes::new();
    f.camera.cameras.store(0, Ordering::SeqCst);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(2), ("unavailable".into(), "no-camera".into()));
    assert_eq!(rig.f.ui.ever_shown(), 0);

    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::Denied);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(2), ("denied".into(), "camera".into()));
    assert_eq!(rig.f.ui.ever_shown(), 0);

    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::NotDeclared);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(
        rig.error(2),
        ("unavailable".into(), "not-declared:camera".into())
    );

    // An OS refusal while opening (e.g. TCC denied mid-flight) is `denied`.
    let f = Fakes::new();
    *f.camera.open_error.lock().unwrap() = Some(HwError::Denied("camera".into()));
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(2), ("denied".into(), "camera".into()));
    rig.wait("the panel closes", |r| r.f.ui.camera().is_none());
}

#[test]
fn camera_os_prompt_runs_first_when_the_permission_is_undecided() {
    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::Prompt);
    *f.perms.answer.lock().unwrap() = Some(PermissionState::Granted);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    wait_live_camera(&mut rig);
    assert_eq!(rig.f.perms.asked.load(Ordering::SeqCst), 1);

    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::Prompt);
    *f.perms.answer.lock().unwrap() = Some(PermissionState::Denied);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(2), ("denied".into(), "camera".into()));
}

#[test]
fn no_visible_window_means_no_presenter() {
    let f = Fakes::new();
    f.ui.hidden.store(true, Ordering::SeqCst);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    assert_eq!(rig.error(2), ("unavailable".into(), "no-presenter".into()));
    rig.send(&request(
        3,
        "mic.record",
        65_536,
        json!({"format":"pcm16","sampleRate":16000}),
    ));
    assert_eq!(rig.error(3), ("unavailable".into(), "no-presenter".into()));
    rig.send(&request(4, "bluetooth.scan", 64, json!({})));
    assert_eq!(
        rig.error(4),
        ("unavailable".into(), "no-activity-indicator".into())
    );
}

#[test]
fn one_prompt_at_a_time_across_capabilities() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "camera.capture",
        65_536,
        json!({"mode":"photo"}),
    ));
    wait_live_camera(&mut rig);
    rig.send(&request(
        3,
        "mic.record",
        65_536,
        json!({"format":"pcm16","sampleRate":16000}),
    ));
    assert_eq!(rig.error(3).0, "throttled");
    rig.send(&request(4, "bluetooth.select", 0, json!({})));
    assert_eq!(rig.error(4).0, "throttled");
    assert!(rig.terminal(2).is_none(), "the open panel is unaffected");
}

#[test]
fn one_prompt_at_a_time_across_connections_sharing_the_window() {
    // Two connections (two RemoteModules) present in the same window: the
    // real overlay hub holds one modal at a time.
    let hub = Arc::new(OverlayHub::new());
    hub.set_available(Some(true)); // this CI box has no display
    hub.attach_window(Arc::new(|| {}));
    let a = Fakes::new();
    let cfg_a =
        DeviceConfig::with_dialogs(Arc::new(NoDialogs)).with_capture(hub.clone(), a.hardware());
    let mut first = Rig::with_config(a, cfg_a, "ws://a.example");
    let b = Fakes::new();
    let cfg_b =
        DeviceConfig::with_dialogs(Arc::new(NoDialogs)).with_capture(hub.clone(), b.hardware());
    let mut second = Rig::with_config(b, cfg_b, "ws://b.example");
    first.send(&request(
        2,
        "mic.record",
        65_536,
        json!({"format":"pcm16","sampleRate":16000}),
    ));
    first.wait("consent shown", |_| !hub.is_empty());
    second.send(&request(
        2,
        "mic.record",
        65_536,
        json!({"format":"pcm16","sampleRate":16000}),
    ));
    assert_eq!(
        second.error(2),
        ("throttled".into(), "another device prompt is open".into())
    );
    assert!(first.terminal(2).is_none());
}

// ---------------------------------------------------------------------------
// mic.record
// ---------------------------------------------------------------------------

fn mic_params(rate: u32, channels: u16, max_ms: Option<u64>) -> Value {
    let mut p = json!({"format":"pcm16","sampleRate":rate,"channels":channels});
    if let Some(ms) = max_ms {
        p["maxDurationMs"] = json!(ms);
    }
    p
}

fn start_recording(rig: &mut Rig, id: u32, params: Value) -> SurfaceId {
    rig.send(&request(id, "mic.record", 262_144, params));
    rig.wait("consent dialog", |r| r.f.ui.consent().is_some());
    assert!(rig.f.ui.indicator(IndicatorKind::Microphone).is_none());
    assert_eq!(
        rig.f.mic.started.load(Ordering::SeqCst),
        0,
        "nothing records before consent"
    );
    let consent = rig.f.ui.consent().unwrap();
    match rig
        .f
        .ui
        .open()
        .into_iter()
        .find(|(s, _)| *s == consent)
        .unwrap()
        .1
    {
        Surface::Consent(p) => {
            assert_eq!(p.origin, "ws://localhost:3000");
            assert!(p.operation.contains("microphone"));
        }
        other => panic!("{other:?}"),
    }
    rig.f.ui.act(consent, UiAction::Continue);
    rig.wait("recording indicator", |r| {
        r.f.ui.indicator(IndicatorKind::Microphone).is_some()
    });
    assert!(rig.f.ui.consent().is_none());
    rig.f.ui.indicator(IndicatorKind::Microphone).unwrap()
}

#[test]
fn mic_records_pcm16_under_a_visible_indicator_until_stop() {
    let mut rig = Rig::new(Fakes::new());
    let indicator = start_recording(&mut rig, 2, mic_params(16_000, 1, None));
    rig.wait("pcm bytes", |r| {
        r.frames.iter().map(|(_, p)| p.len()).sum::<usize>() > 8_000
    });
    // The indicator is up exactly while the microphone runs.
    assert_eq!(rig.f.mic.live.load(Ordering::SeqCst), 1);
    assert!(rig.status(2).unwrap().hardware_active);
    rig.f.ui.act(indicator, UiAction::Stop);
    let t = rig.wait_terminal(2);
    assert_eq!(
        rig.f.mic.live.load(Ordering::SeqCst),
        0,
        "Stop turned the microphone off"
    );
    assert!(rig.f.ui.indicator(IndicatorKind::Microphone).is_none());
    let pcm = rig.upload(2);
    assert_eq!(pcm.len() % 2, 0, "whole mono PCM16 frames");
    let start = blob_start(&rig, 2);
    assert_eq!(start["contentType"], "audio/L16");
    assert!(start.get("bytes").is_none());
    assert_eq!(
        t["result"],
        json!({"durationMs": pcm::duration_ms(pcm.len() as u64 / 2, 16_000),
               "item":{"channel":0,"contentType":"audio/L16","bytes":pcm.len(),"sha256":sha(&pcm)}})
    );
    assert_eq!(rig.progress(2), ["pendingConsent", "running"]);
    // The converter really resampled 48 kHz stereo to 16 kHz mono: the
    // fake source's L/R are opposite, so the mono mix is silence.
    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    assert!(samples.iter().all(|s| s.abs() <= 1), "L+R cancel");
}

#[test]
fn mic_stereo_keeps_interleaved_channels() {
    let mut rig = Rig::new(Fakes::new());
    let indicator = start_recording(&mut rig, 2, mic_params(48_000, 2, None));
    rig.wait("pcm bytes", |r| {
        r.frames.iter().map(|(_, p)| p.len()).sum::<usize>() > 4_000
    });
    rig.f.ui.act(indicator, UiAction::Stop);
    rig.wait_terminal(2);
    let pcm = rig.upload(2);
    assert_eq!(pcm.len() % 4, 0, "whole stereo frames");
    let s: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    assert!(
        s.chunks_exact(2)
            .all(|lr| lr[0] == -lr[1] || (lr[0] + lr[1]).abs() <= 1),
        "L = -R"
    );
    assert!(s.iter().any(|&v| v.abs() > 1000), "not silence");
}

#[test]
fn mic_max_duration_is_exact_and_ends_normally() {
    let mut rig = Rig::new(Fakes::new());
    let _ = start_recording(&mut rig, 2, mic_params(16_000, 1, Some(100)));
    let t = rig.wait_terminal(2);
    let pcm = rig.upload(2);
    assert_eq!(pcm.len(), 1_600 * 2, "100 ms at 16 kHz mono");
    assert_eq!(t["result"]["durationMs"], 100);
    assert_eq!(t["result"]["item"]["sha256"], sha(&pcm));
    rig.wait("mic off", |r| r.f.mic.live.load(Ordering::SeqCst) == 0);
    assert!(
        rig.f.ui.indicator(IndicatorKind::Microphone).is_none(),
        "indicator down with the mic"
    );
}

#[test]
fn mic_consent_cancel_is_a_refusal_and_escape_is_abandonment() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    rig.f.ui.act(rig.f.ui.consent().unwrap(), UiAction::Cancel);
    assert_eq!(rig.error(2), ("denied".into(), "host-refused".into()));
    assert_eq!(rig.f.mic.started.load(Ordering::SeqCst), 0);
    assert!(rig.f.ui.open().is_empty());
    rig.send(&request(
        3,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    assert_eq!(rig.error(3), ("throttled".into(), "cooldown".into()));

    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(
        2,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    rig.f.ui.act(rig.f.ui.consent().unwrap(), UiAction::Dismiss);
    assert_eq!(
        rig.error(2),
        ("cancelled".into(), "consent-dismissed".into())
    );
}

#[test]
fn server_cancel_mid_recording_stops_mic_and_indicator() {
    let mut rig = Rig::new(Fakes::new());
    let _ = start_recording(&mut rig, 2, mic_params(16_000, 1, None));
    rig.wait("pcm bytes", |r| !r.frames.is_empty());
    rig.send(&control(2, json!({"cancel": true})));
    assert_eq!(rig.error(2).0, "cancelled");
    assert_eq!(rig.f.mic.live.load(Ordering::SeqCst), 0);
    assert!(rig.f.ui.indicator(IndicatorKind::Microphone).is_none());
}

#[test]
fn mic_starved_of_credit_ends_throttled_with_a_bounded_buffer() {
    let mut rig = Rig::new(Fakes::new());
    rig.auto_grant = false;
    let _ = start_recording(&mut rig, 2, mic_params(48_000, 2, None));
    assert_eq!(
        rig.error(2),
        ("throttled".into(), "capture-buffer-full".into())
    );
    let sent: usize = rig.frames.iter().map(|(_, p)| p.len()).sum();
    assert!(sent <= 262_144, "never beyond the granted credit");
    assert!(
        rig.texts.iter().any(|m| m["control"]["paused"] == true),
        "reported paused"
    );
    assert_eq!(rig.f.mic.live.load(Ordering::SeqCst), 0);
    assert!(rig.f.ui.indicator(IndicatorKind::Microphone).is_none());
}

#[test]
fn hiding_the_window_stops_a_recording_normally() {
    let mut rig = Rig::new(Fakes::new());
    let indicator = start_recording(&mut rig, 2, mic_params(16_000, 1, None));
    rig.wait("pcm", |r| !r.frames.is_empty());
    rig.f.ui.act(indicator, UiAction::Hidden);
    let t = rig.wait_terminal(2);
    assert!(t.get("result").is_some(), "{t}");
    assert_eq!(rig.f.mic.live.load(Ordering::SeqCst), 0);
}

#[test]
fn mic_hardware_failures_are_unavailable() {
    let f = Fakes::new();
    f.mic.absent.store(true, Ordering::SeqCst);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    assert_eq!(rig.error(2), ("unavailable".into(), "no-microphone".into()));
    assert_eq!(rig.f.ui.ever_shown(), 0);

    let f = Fakes::new();
    *f.mic.start_error.lock().unwrap() = Some(HwError::Unavailable("microphone-busy".into()));
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    rig.f
        .ui
        .act(rig.f.ui.consent().unwrap(), UiAction::Continue);
    assert_eq!(
        rig.error(2),
        ("unavailable".into(), "microphone-busy".into())
    );
    assert!(
        rig.f.ui.open().is_empty(),
        "the indicator went down with the failure"
    );

    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Microphone, PermissionState::Denied);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "mic.record",
        65_536,
        mic_params(16_000, 1, None),
    ));
    assert_eq!(rig.error(2), ("denied".into(), "microphone".into()));
}

#[test]
fn socket_loss_during_recording_stops_everything_silently() {
    let mut rig = Rig::new(Fakes::new());
    let _ = start_recording(&mut rig, 2, mic_params(16_000, 1, None));
    rig.wait("pcm", |r| !r.frames.is_empty());
    let texts = rig.texts.len();
    rig.device.detach();
    assert_eq!(rig.f.mic.live.load(Ordering::SeqCst), 0);
    assert!(rig.f.ui.open().is_empty());
    std::thread::sleep(Duration::from_millis(20));
    rig.pump();
    assert_eq!(rig.texts.len(), texts, "nothing is sent after the reset");
}

// ---------------------------------------------------------------------------
// bluetooth
// ---------------------------------------------------------------------------

const HR: &str = "0000180d-0000-1000-8000-00805f9b34fb";
const BAT: &str = "0000180f-0000-1000-8000-00805f9b34fb";

fn ad(raw: &str, name: Option<&str>, rssi: i16, services: &[&str]) -> Advertisement {
    Advertisement {
        raw_id: raw.into(),
        name: name.map(str::to_string),
        rssi,
        services: services.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn bluetooth_scan_streams_opaque_coalesced_devices_under_an_indicator() {
    let f = Fakes::new();
    *f.bt.ads.lock().unwrap() = vec![
        ad("AA:BB:CC:DD:EE:01", Some("Tag"), -60, &[]),
        ad("AA:BB:CC:DD:EE:02", None, -80, &[HR]),
    ];
    let mut rig = Rig::new(f);
    rig.send(&request(2, "bluetooth.scan", 64, json!({})));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    assert_eq!(
        rig.f.bt.scans.load(Ordering::SeqCst),
        0,
        "no scan before consent"
    );
    rig.f
        .ui
        .act(rig.f.ui.consent().unwrap(), UiAction::Continue);
    rig.wait("device events", |r| {
        r.events(2)
            .iter()
            .filter(|e| e.get("device").is_some())
            .count()
            >= 4
    });
    let indicator = rig
        .f
        .ui
        .indicator(IndicatorKind::BluetoothScan)
        .expect("scanning indicator");
    let devices: Vec<Value> = rig
        .events(2)
        .into_iter()
        .filter(|e| e.get("device").is_some())
        .collect();
    for d in &devices {
        let id = d["device"]["id"].as_str().unwrap();
        assert!(
            !id.to_ascii_uppercase().contains("AA:BB"),
            "never the MAC: {id}"
        );
        assert_eq!(id.len(), 36);
    }
    let ids: std::collections::HashSet<&str> = devices
        .iter()
        .map(|d| d["device"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "one stable opaque id per device");
    assert!(devices.iter().any(|d| d["device"]["name"] == "Tag"));
    // Coalescing: far fewer events than advertisements.
    assert_eq!(rig.progress(2), ["pendingConsent", "running"]);
    // Stop ends the scan `cancelled` (user-stopped); scan and indicator go.
    rig.f.ui.act(indicator, UiAction::Stop);
    assert_eq!(rig.error(2), ("cancelled".into(), "user-stopped".into()));
    assert_eq!(rig.f.bt.live.load(Ordering::SeqCst), 0);
    assert!(rig.f.ui.indicator(IndicatorKind::BluetoothScan).is_none());

    // The consent is remembered for this ws:// connection only.
    rig.send(&request(3, "bluetooth.scan", 64, json!({})));
    rig.wait("second scan runs", |r| {
        r.f.ui.indicator(IndicatorKind::BluetoothScan).is_some()
    });
    assert_eq!(rig.f.ui.consent(), None);
    rig.f.ui.act(
        rig.f.ui.indicator(IndicatorKind::BluetoothScan).unwrap(),
        UiAction::Hidden,
    );
    assert_eq!(
        rig.error(3),
        ("cancelled".into(), "indicator-hidden".into())
    );
    rig.device.attach("ws://localhost:3000".into());
    let ack = ack_for(rig.device.host());
    rig.device.on_ack(Some(&ack));
    rig.send(&core_request(1));
    rig.send(&request(2, "bluetooth.scan", 64, json!({})));
    rig.wait("consent again on a new ws:// connection", |r| {
        r.f.ui.consent().is_some()
    });
}

#[test]
fn bluetooth_opaque_ids_differ_per_origin() {
    let mk = |origin: &str| {
        let f = Fakes::new();
        *f.bt.ads.lock().unwrap() = vec![ad("AA:BB:CC:DD:EE:01", Some("Tag"), -60, &[])];
        let mut rig = Rig::with_origin(f, origin);
        rig.send(&request(2, "bluetooth.scan", 64, json!({})));
        rig.wait("consent", |r| r.f.ui.consent().is_some());
        rig.f
            .ui
            .act(rig.f.ui.consent().unwrap(), UiAction::Continue);
        rig.wait("a device", |r| {
            r.events(2).iter().any(|e| e.get("device").is_some())
        });
        rig.events(2)
            .into_iter()
            .find(|e| e.get("device").is_some())
            .unwrap()["device"]["id"]
            .clone()
    };
    let a = mk("wss://a.example");
    assert_eq!(a, mk("wss://a.example"), "stable for an origin");
    assert_ne!(a, mk("wss://b.example"), "unlinkable across origins");
}

#[test]
fn bluetooth_select_lists_only_filtered_devices_and_returns_identity() {
    let f = Fakes::new();
    *f.bt.ads.lock().unwrap() = vec![
        ad("M1", Some("Polar H10"), -55, &[HR, BAT]),
        ad("M2", Some("Polar OH1"), -60, &[BAT]),
        ad("M3", Some("Garmin HRM"), -50, &[HR]),
        ad("M4", None, -40, &[HR]),
    ];
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "bluetooth.select",
        0,
        json!({"services":[HR],"namePrefix":"Polar"}),
    ));
    rig.wait("chooser lists a device", |r| {
        r.f.ui
            .chooser()
            .is_some_and(|c| !r.f.ui.devices(c).is_empty())
    });
    std::thread::sleep(Duration::from_millis(20));
    rig.pump();
    let chooser = rig.f.ui.chooser().unwrap();
    let listed = rig.f.ui.devices(chooser);
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].name.as_deref(), Some("Polar H10"));
    assert_eq!(rig.progress(2), ["pendingConsent"]);
    rig.f
        .ui
        .act(chooser, UiAction::Choose(listed[0].id.clone()));
    let t = rig.wait_terminal(2);
    assert_eq!(
        t["result"],
        json!({"device":{"id":listed[0].id,"name":"Polar H10"}})
    );
    assert!(rig.f.ui.chooser().is_none());
    assert_eq!(
        rig.f.bt.live.load(Ordering::SeqCst),
        0,
        "the chooser's scan stopped"
    );
}

#[test]
fn bluetooth_select_without_filters_lists_everything_and_cancel_is_cancelled() {
    let f = Fakes::new();
    *f.bt.ads.lock().unwrap() = vec![ad("M1", Some("A"), -55, &[]), ad("M2", None, -60, &[])];
    let mut rig = Rig::new(f);
    rig.send(&request(2, "bluetooth.select", 0, json!({})));
    rig.wait("two devices", |r| {
        r.f.ui
            .chooser()
            .is_some_and(|c| r.f.ui.devices(c).len() == 2)
    });
    // A forged / unlisted id is ignored.
    let chooser = rig.f.ui.chooser().unwrap();
    rig.f.ui.act(chooser, UiAction::Choose("not-listed".into()));
    rig.pump();
    assert!(rig.terminal(2).is_none());
    rig.f.ui.act(chooser, UiAction::Cancel);
    assert_eq!(
        rig.error(2),
        ("cancelled".into(), "chooser-dismissed".into())
    );
    assert_eq!(rig.f.bt.live.load(Ordering::SeqCst), 0);
}

#[test]
fn bluetooth_without_an_adapter_is_unavailable() {
    for (err, detail) in [
        (HwError::NoDevice("no-adapter"), "no-adapter"),
        (HwError::Unavailable("adapter-off".into()), "adapter-off"),
    ] {
        let f = Fakes::new();
        *f.bt.adapter.lock().unwrap() = Some(err.clone());
        let mut rig = Rig::new(f);
        rig.send(&request(2, "bluetooth.scan", 64, json!({})));
        assert_eq!(rig.error(2), ("unavailable".into(), detail.into()));
        rig.send(&request(3, "bluetooth.select", 0, json!({})));
        assert_eq!(rig.error(3), ("unavailable".into(), detail.into()));
        assert_eq!(rig.f.ui.ever_shown(), 0);
    }
}

#[test]
fn bluetooth_consent_refusal_is_denied() {
    let mut rig = Rig::new(Fakes::new());
    rig.send(&request(2, "bluetooth.scan", 64, json!({})));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    rig.f.ui.act(rig.f.ui.consent().unwrap(), UiAction::Cancel);
    assert_eq!(rig.error(2), ("denied".into(), "host-refused".into()));
    assert_eq!(rig.f.bt.scans.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

#[test]
fn permission_query_reports_the_platform_state_without_prompting() {
    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::Denied);
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Microphone, PermissionState::Prompt);
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Location, PermissionState::Unsupported);
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Bluetooth, PermissionState::NotDeclared);
    let mut rig = Rig::new(f);
    rig.send(&request(
        2,
        "permission.query",
        0,
        json!({"permission":"camera"}),
    ));
    let t = rig.wait_terminal(2);
    assert_eq!(t["result"], json!({"status":"denied"}), "{t}");
    rig.send(&request(
        3,
        "permission.query",
        0,
        json!({"permission":"microphone"}),
    ));
    assert_eq!(rig.wait_terminal(3)["result"], json!({"status":"prompt"}));
    rig.send(&request(
        4,
        "permission.query",
        0,
        json!({"permission":"location"}),
    ));
    assert_eq!(rig.error(4), ("unsupported".into(), "location".into()));
    rig.send(&request(
        5,
        "permission.query",
        0,
        json!({"permission":"bluetooth"}),
    ));
    assert_eq!(
        rig.error(5),
        ("unavailable".into(), "not-declared:bluetooth".into())
    );
    rig.send(&request(
        6,
        "permission.query",
        0,
        json!({"permission":"photos"}),
    ));
    assert_eq!(rig.wait_terminal(6)["result"], json!({"status":"granted"}));
    assert_eq!(rig.f.perms.asked.load(Ordering::SeqCst), 0);
    assert_eq!(rig.f.ui.ever_shown(), 0, "query never prompts");
}

#[test]
fn permission_request_prompts_only_when_the_os_would() {
    let f = Fakes::new();
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Camera, PermissionState::Prompt);
    f.perms
        .states
        .lock()
        .unwrap()
        .insert(Permission::Microphone, PermissionState::Denied);
    *f.perms.answer.lock().unwrap() = Some(PermissionState::Granted);
    let mut rig = Rig::new(f);
    // Already decided: answered without any dialog.
    rig.send(&request(
        2,
        "permission.request",
        0,
        json!({"permission":"microphone"}),
    ));
    let t = rig.wait_terminal(2);
    assert_eq!(t["result"], json!({"status":"denied"}), "{t}");
    assert_eq!(rig.f.ui.ever_shown(), 0);
    // Undecided: host consent first, then the OS prompt.
    rig.send(&request(
        3,
        "permission.request",
        0,
        json!({"permission":"camera"}),
    ));
    rig.wait("consent", |r| r.f.ui.consent().is_some());
    assert_eq!(rig.f.perms.asked.load(Ordering::SeqCst), 0);
    rig.f
        .ui
        .act(rig.f.ui.consent().unwrap(), UiAction::Continue);
    assert_eq!(rig.wait_terminal(3)["result"], json!({"status":"granted"}));
    assert_eq!(rig.f.perms.asked.load(Ordering::SeqCst), 1);
    assert_eq!(rig.progress(3), ["pendingConsent", "running"]);
}
