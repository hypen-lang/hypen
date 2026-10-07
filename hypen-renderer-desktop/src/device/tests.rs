//! Unit tests of the desktop DeviceHost: the protocol core driven directly,
//! and the IO owner (`DesktopDevice`) with scripted dialogs.

use super::*;
use hypen_engine::serialize::device::{
    CapabilityOffer, DeviceAck, DeviceHello, DeviceMessage, FrameHeader, FRAME_VERSION,
};
use std::path::Path;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// helpers
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
    json!({"type":"deviceRequest","id":id,"capability":capability,"version":1,
           "owner":{"moduleInstanceId":"app@s#1","activationId":1},"lifetime":"activation",
           "timeoutMs":300_000,"initialCredit":credit,"params":params})
    .to_string()
}

fn control(id: u32, control: Value) -> String {
    json!({"type":"deviceEvent","id":id,"control":control}).to_string()
}

/// A connected host with the core stream open.
fn ready_host(caps: &[&str]) -> DeviceHost {
    let mut host = DeviceHost::new(caps, HostOptions::default());
    host.attach();
    let ack = ack_for(&host);
    host.on_ack(Some(&ack));
    host.on_text(&core_request(1), 0);
    let _ = host.poll();
    host
}

fn texts(outs: &[HostOutput]) -> Vec<Value> {
    outs.iter()
        .filter_map(|o| match o {
            HostOutput::SendText(t) => {
                // Everything the host sends must pass the strict decoder.
                DeviceMessage::decode(t).unwrap_or_else(|e| panic!("invalid output {t}: {e}"));
                Some(serde_json::from_str(t).unwrap())
            }
            _ => None,
        })
        .collect()
}

fn frames(outs: &[HostOutput]) -> Vec<(FrameHeader, Vec<u8>)> {
    outs.iter()
        .filter_map(|o| match o {
            HostOutput::SendFrame(f) => {
                let (h, p) = FrameHeader::decode(f).unwrap();
                Some((h, p.to_vec()))
            }
            _ => None,
        })
        .collect()
}

fn error_code(outs: &[HostOutput], id: u32) -> Option<String> {
    texts(outs).into_iter().find_map(|m| {
        (m["type"] == "deviceResponse" && m["id"] == id)
            .then(|| m["error"]["code"].as_str().map(str::to_string))
            .flatten()
    })
}

fn pump(host: &mut DeviceHost) -> Vec<HostOutput> {
    let mut all = Vec::new();
    loop {
        let outs = host.poll();
        let empty = outs.is_empty();
        all.extend(outs);
        if empty && !host.has_ready_work() {
            return all;
        }
    }
}

fn frame(id: u32, seq: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = FrameHeader {
        version: FRAME_VERSION,
        flags: 0,
        channel: 0,
        request_id: id,
        seq,
    }
    .encode()
    .to_vec();
    f.extend_from_slice(payload);
    f
}

fn sha(bytes: &[u8]) -> String {
    hypen_engine::device::sha256_hex(bytes)
}

// ---------------------------------------------------------------------------
// handshake / advertisement
// ---------------------------------------------------------------------------

#[test]
fn advertisement_is_core_plus_implemented_registry_revisions() {
    let host = DeviceHost::new(
        &["file.pick", "file.save", "no.such", "file.pick"],
        HostOptions::default(),
    );
    let hello = host.hello_device();
    // Valid handshake-v1 text, as the server's strict decoder reads it.
    let decoded = DeviceHello::decode(&hello.to_string()).unwrap();
    let names: Vec<&str> = decoded
        .capabilities
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["core.capabilities", "file.pick", "file.save"]);
    assert!(decoded.binary);
    assert_eq!(decoded.protocol_versions, [1]);
}

#[test]
fn desktop_config_advertises_only_when_dialogs_can_show() {
    let shown = DeviceConfig::with_dialogs(Arc::new(ScriptedDialogs::default()));
    assert_eq!(
        shown.advertised(),
        ["file.pick", "gallery.pick", "file.save"]
    );
    let headless = DeviceConfig::with_dialogs(Arc::new(ScriptedDialogs {
        unavailable: true,
        ..Default::default()
    }));
    assert!(headless.advertised().is_empty());
    let narrowed = shown.clone().capabilities(&["file.save", "camera.capture"]);
    assert_eq!(narrowed.advertised(), ["file.save"]);
}

#[test]
fn ack_selection_is_validated_against_the_advertisement() {
    let mut host = DeviceHost::new(&["file.pick"], HostOptions::default());
    host.attach();
    // Before any ack with `device`: nothing is selected (D6), device traffic
    // is ignored entirely.
    host.on_ack(None);
    assert!(host.selected().is_none());
    host.on_text(&core_request(1), 0);
    assert!(host.poll().is_empty());
    // An ack naming things never offered keeps only what was offered.
    let ack = json!({"protocolVersion":1,"binary":true,"capabilities":[
        {"name":"core.capabilities","version":1},{"name":"file.pick","version":1},
        {"name":"camera.capture","version":1}]});
    host.on_ack(Some(&ack.to_string()));
    let live: Vec<_> = host.live_selection().keys().cloned().collect();
    assert_eq!(live, ["core.capabilities", "file.pick"]);
    // Immutable for the socket: a later ack cannot change it.
    host.on_ack(Some(
        r#"{"protocolVersion":1,"binary":true,"capabilities":[]}"#,
    ));
    assert_eq!(host.live_selection().len(), 2);
}

#[test]
fn invalid_or_core_less_acks_keep_the_plane_off() {
    for ack in [
        "not json",
        r#"{"protocolVersion":1,"binary":true,"capabilities":[{"name":"file.pick","version":1}]}"#,
        r#"{"protocolVersion":2,"binary":true,"capabilities":[{"name":"core.capabilities","version":1}]}"#,
        r#"{"protocolVersion":1,"binary":true,"capabilities":[{"name":"core.capabilities","version":1},{"name":"core.capabilities","version":1}]}"#,
    ] {
        let mut host = DeviceHost::new(&["file.pick"], HostOptions::default());
        host.attach();
        host.on_ack(Some(ack));
        assert!(host.selected().is_none(), "{ack}");
    }
}

#[test]
fn every_selection_fixture_the_server_picks_is_accepted_unchanged() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/conformance/selection.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut checked = 0;
    for case in doc["cases"].as_array().unwrap() {
        let Ok(hello) = DeviceHello::from_value(&case["hello"]) else {
            continue; // an invalid hello never gets an ack
        };
        if case["expect"].is_null() {
            continue;
        }
        let expect: DeviceAck = serde_json::from_value(case["expect"].clone()).unwrap();
        assert_eq!(
            host::accept_selection(&expect, &hello).as_ref(),
            Some(&expect),
            "{}",
            case["name"]
        );
        checked += 1;
    }
    assert!(checked >= 10, "{checked}");
}

// ---------------------------------------------------------------------------
// connection model and violations
// ---------------------------------------------------------------------------

#[test]
fn app_request_before_core_closes_the_connection() {
    let mut host = DeviceHost::new(&["file.pick"], HostOptions::default());
    host.attach();
    let ack = ack_for(&host);
    host.on_ack(Some(&ack));
    host.on_text(
        &request(1, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    let outs = host.poll();
    assert!(
        matches!(outs.last(), Some(HostOutput::Close { code: 1002, .. })),
        "{outs:?}"
    );
    assert!(host.selected().is_none(), "detached");
}

#[test]
fn core_stream_opens_with_a_full_snapshot() {
    let mut host = DeviceHost::new(&["file.save"], HostOptions::default());
    host.attach();
    let ack = ack_for(&host);
    host.on_ack(Some(&ack));
    host.on_text(&core_request(1), 0);
    let outs = texts(&host.poll());
    assert_eq!(outs.len(), 1);
    assert_eq!(
        outs[0]["event"]["capabilities"],
        json!([{"name":"core.capabilities","versions":[1]},{"name":"file.save","versions":[1]}])
    );
    // A second live core stream breaks the connection model.
    host.on_text(&core_request(2), 0);
    assert!(matches!(host.poll().last(), Some(HostOutput::Close { .. })));
}

#[test]
fn garbage_is_connection_level_and_closes_only_when_repeated() {
    let mut host = ready_host(&["file.pick"]);
    host.on_text(
        &request(2, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    let outs = host.poll();
    assert!(matches!(outs[0], HostOutput::Start(_)));
    // Unattributable garbage: counted, nothing sent, the live request stays.
    for bad in [
        r#"{"type":"deviceEvent","id":2,"id":2,"control":{"renewLease":1}}"#, // duplicate key
        r#"{"type":"deviceEvent","id":2,"control":{"grant":1.0}}"#,           // non-integer token
        r#"{"type":"deviceRequest"}"#,                                        // no id
        "{not json",
    ] {
        host.on_text(bad, 0);
        assert!(host.poll().is_empty(), "{bad}");
    }
    let mut bad_version = frame(2, 0, b"x");
    bad_version[0] = 9;
    host.on_frame(&bad_version, 0);
    let mut bad_flags = frame(2, 0, b"x");
    bad_flags[1] = 1;
    host.on_frame(&bad_flags, 0);
    host.on_frame(&[1, 0, 0], 0); // short header: dropped, not even counted
    assert!(host.poll().is_empty());
    assert_eq!(host.connection_violations(), 6);
    assert!(host.is_live(2));
    // Oversize text claiming a device type is never parsed.
    let huge = format!(
        r#"{{"type":"deviceEvent","id":2,"pad":"{}"}}"#,
        "x".repeat(1 << 20)
    );
    host.on_text(&huge, 0);
    assert!(host.poll().is_empty());
    assert_eq!(host.connection_violations(), 7);
    // Repeated abuse closes the socket (default budget 32).
    for _ in 0..25 {
        host.on_text("[]", 0);
    }
    let outs = host.poll();
    assert!(
        matches!(outs.last(), Some(HostOutput::Close { code: 1002, .. })),
        "{outs:?}"
    );
    assert!(outs.contains(&HostOutput::Stop { id: 2 }));
}

#[test]
fn unknown_ids_are_ignored_whatever_they_carry() {
    let mut host = ready_host(&["file.pick"]);
    for msg in [
        control(77, json!({"renewLease": 1})),
        control(77, json!({"cancel": true})),
        control(77, json!({"leaseAck": 3})),
        json!({"type":"deviceResponse","id":77,"result":{}}).to_string(),
        json!({"type":"deviceEvent","id":77,"event":{"kind":"progress","state":"running"}})
            .to_string(),
        json!({"type":"deviceEvent","id":77,"control":{"grant":0}}).to_string(), // invalid AND unknown
    ] {
        host.on_text(&msg, 0);
    }
    host.on_frame(&frame(77, 0, b"abc"), 0);
    assert!(host.poll().is_empty());
    assert_eq!(host.connection_violations(), 0);
}

#[test]
fn known_id_violations_terminate_only_that_request() {
    let mut host = ready_host(&["file.pick", "file.save"]);
    host.on_text(
        &request(2, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    host.on_text(
        &request(3, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    let _ = host.poll();
    // A server deviceResponse on a live id, a lease ack from the server, a
    // capability event from the server: each is a known-id violation.
    host.on_text(
        &json!({"type":"deviceResponse","id":2,"result":{}}).to_string(),
        0,
    );
    let outs = host.poll();
    assert_eq!(error_code(&outs, 2).as_deref(), Some("invalidParams"));
    assert!(outs.contains(&HostOutput::Stop { id: 2 }));
    assert!(host.is_live(3));
    host.on_text(&control(3, json!({"grant": 9_000_000})), 0); // over maxOutstandingCredit
    assert_eq!(
        error_code(&host.poll(), 3).as_deref(),
        Some("invalidParams")
    );
    // Frames against an upload's direction.
    host.on_text(
        &request(4, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    let _ = host.poll();
    host.on_frame(&frame(4, 0, b"x"), 0);
    assert_eq!(
        error_code(&host.poll(), 4).as_deref(),
        Some("invalidParams")
    );
    // A malformed but attributable request with a new id is refused.
    host.on_text(
        &json!({"type":"deviceRequest","id":5,"capability":"file.pick","version":1}).to_string(),
        0,
    );
    assert_eq!(
        error_code(&host.poll(), 5).as_deref(),
        Some("invalidParams")
    );
    // Unknown revision / not selected → unsupported.
    host.on_text(&request(6, "camera.capture", 0, json!({"mode":"photo"})), 0);
    assert_eq!(error_code(&host.poll(), 6).as_deref(), Some("unsupported"));
    // Params that do not fit the revision → invalidParams.
    host.on_text(
        &request(7, "file.pick", 65536, json!({"accept":[],"maxCount":0})),
        0,
    );
    assert_eq!(
        error_code(&host.poll(), 7).as_deref(),
        Some("invalidParams")
    );
    // Duplicate / older ids are dropped without executing again.
    host.on_text(
        &request(7, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    host.on_text(
        &request(3, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    assert!(host.poll().is_empty());
}

#[test]
fn activation_ids_never_go_backwards() {
    let mut host = ready_host(&["file.pick"]);
    let req = |id: u32, act: u32| {
        json!({"type":"deviceRequest","id":id,"capability":"file.pick","version":1,
               "owner":{"moduleInstanceId":"m","activationId":act},"lifetime":"activation",
               "timeoutMs":1000,"initialCredit":1024,"params":{"accept":[],"maxCount":1}})
        .to_string()
    };
    host.on_text(&req(2, 5), 0);
    host.on_text(&req(3, 4), 0);
    let outs = host.poll();
    assert!(matches!(
        outs[0],
        HostOutput::Start(StartRequest { id: 2, .. })
    ));
    assert_eq!(error_code(&outs, 3).as_deref(), Some("invalidParams"));
}

// ---------------------------------------------------------------------------
// leases, deadlines, cancellation
// ---------------------------------------------------------------------------

#[test]
fn leases_are_acknowledged_and_expire() {
    let mut host = ready_host(&["file.pick"]);
    host.on_text(
        &request(2, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        1_000,
    );
    let _ = host.poll();
    host.on_text(&control(2, json!({"renewLease": 1})), 2_000);
    assert_eq!(texts(&host.poll())[0]["control"], json!({"leaseAck": 1}));
    // Sequences strictly increase (may skip); a repeat is a violation.
    host.on_text(&control(2, json!({"renewLease": 3})), 7_000);
    assert_eq!(texts(&host.poll())[0]["control"], json!({"leaseAck": 3}));
    host.tick(21_999);
    assert!(host.is_live(2), "15 s after the last accepted renewal");
    host.tick(22_000);
    let outs = host.poll();
    assert_eq!(error_code(&outs, 2).as_deref(), Some("connectionLost"));
    assert!(outs.contains(&HostOutput::Stop { id: 2 }));

    host.on_text(
        &request(3, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        30_000,
    );
    host.on_text(&control(3, json!({"renewLease": 2})), 30_001);
    assert_eq!(
        error_code(&host.poll(), 3).as_deref(),
        Some("invalidParams"),
        "first must be 1"
    );
}

#[test]
fn deadlines_use_the_client_clamp_and_cancel_answers_cancelled() {
    let mut host = DeviceHost::new(
        &["file.pick"],
        HostOptions {
            max_timeout_ms: 2_000,
            ..HostOptions::default()
        },
    );
    host.attach();
    let ack = ack_for(&host);
    host.on_ack(Some(&ack));
    host.on_text(&core_request(1), 0);
    host.on_text(
        &request(2, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    host.on_text(
        &request(3, "file.pick", 65536, json!({"accept":[],"maxCount":1})),
        0,
    );
    let _ = host.poll();
    host.on_text(&control(3, json!({"cancel": true})), 10);
    assert_eq!(error_code(&host.poll(), 3).as_deref(), Some("cancelled"));
    for t in (0..2_000).step_by(1_000) {
        host.on_text(&control(2, json!({"renewLease": t / 1_000 + 1})), t);
    }
    assert_eq!(host.next_deadline(), Some(2_000));
    host.tick(2_000);
    assert_eq!(error_code(&host.poll(), 2).as_deref(), Some("timeout"));
    assert!(
        host.is_live(1),
        "the core stream is bounded by its revision, not the clamp"
    );
}

// ---------------------------------------------------------------------------
// uploads and downloads through the core
// ---------------------------------------------------------------------------

#[test]
fn uploads_are_credit_paced_contiguous_and_hash_stated() {
    let mut host = ready_host(&["file.pick"]);
    host.on_text(
        &request(2, "file.pick", 100_000, json!({"accept":[],"maxCount":2})),
        0,
    );
    let _ = host.poll();
    let a: Vec<u8> = (0..150_000u32).map(|i| i as u8).collect();
    let mut extra = Map::new();
    extra.insert("name".into(), json!("a.bin"));
    assert_eq!(
        host.open_blob(
            2,
            "application/octet-stream",
            extra.clone(),
            BlobSource::Bytes(a.clone())
        ),
        Some(0)
    );
    extra.insert("name".into(), json!("empty.txt"));
    assert_eq!(
        host.open_blob(2, "text/plain", extra, BlobSource::Bytes(Vec::new())),
        Some(1)
    );
    host.succeed(2, Map::new(), false);
    let outs = pump(&mut host);
    let sent = frames(&outs);
    let total: usize = sent.iter().map(|(_, p)| p.len()).sum();
    assert_eq!(total, 100_000, "never beyond the credit");
    assert!(sent
        .iter()
        .all(|(_, p)| !p.is_empty() && p.len() <= 64 * 1024));
    assert_eq!(sent.iter().map(|(h, _)| h.seq).collect::<Vec<_>>(), [0, 1]);
    assert!(texts(&outs)
        .iter()
        .any(|m| m["control"] == json!({"paused": true})));
    assert!(!texts(&outs).iter().any(|m| m["type"] == "deviceResponse"));
    // More credit: the rest, then the terminal with the actual items.
    host.on_text(&control(2, json!({"grant": 60_000})), 0);
    let outs = pump(&mut host);
    let msgs = texts(&outs);
    assert_eq!(msgs[0]["control"], json!({"paused": false}));
    let rest: usize = frames(&outs).iter().map(|(_, p)| p.len()).sum();
    assert_eq!(rest, 50_000);
    let result = msgs
        .iter()
        .find(|m| m["type"] == "deviceResponse")
        .expect("terminal");
    assert_eq!(
        result["result"]["items"],
        json!([
            {"channel":0,"name":"a.bin","contentType":"application/octet-stream","bytes":150_000,"sha256":sha(&a)},
            {"channel":1,"name":"empty.txt","contentType":"text/plain","bytes":0,"sha256":sha(&[])},
        ])
    );
    assert!(!host.is_live(2));
}

#[test]
fn downloads_are_verified_before_completion() {
    let body = b"hypen-saved".to_vec();
    let mut host = ready_host(&["file.save"]);
    let params = json!({"channel":0,"name":"a.txt","contentType":"text/plain",
                        "bytes":body.len(),"sha256":sha(&body)});
    host.on_text(&request(2, "file.save", 0, params.clone()), 0);
    let _ = host.poll();
    // Bytes before any grant are beyond credit: a violation.
    host.on_frame(&frame(2, 0, &body), 0);
    assert_eq!(
        error_code(&host.poll(), 2).as_deref(),
        Some("invalidParams")
    );

    host.on_text(&request(3, "file.save", 0, params.clone()), 0);
    let _ = host.poll();
    assert_eq!(host.grant_download(3, 4), 4);
    host.on_frame(&frame(3, 0, &body[..4]), 0);
    host.grant_download(3, 100);
    host.on_frame(&frame(3, 1, &body[4..]), 0);
    let outs = host.poll();
    assert!(outs.contains(&HostOutput::DownloadComplete { id: 3 }));
    let mut result = Map::new();
    result.insert("bytesWritten".into(), json!(body.len()));
    host.succeed(3, result, false);
    assert_eq!(
        texts(&host.poll())[0]["result"],
        json!({"bytesWritten": 11})
    );

    // A hash mismatch is refused, never reported as saved.
    let mut bad = params;
    bad["sha256"] = json!(sha(b"something else"));
    host.on_text(&request(4, "file.save", 0, bad), 0);
    host.grant_download(4, 64);
    host.on_frame(&frame(4, 0, &body), 0);
    let outs = host.poll();
    assert_eq!(error_code(&outs, 4).as_deref(), Some("invalidParams"));
    assert!(!outs.contains(&HostOutput::DownloadComplete { id: 4 }));
}

#[test]
fn republished_snapshots_follow_the_advertisement() {
    let mut host = ready_host(&["file.pick", "file.save"]);
    host.republish(&[
        CapabilityOffer {
            name: "core.capabilities".into(),
            versions: vec![1],
        },
        CapabilityOffer {
            name: "file.save".into(),
            versions: vec![1],
        },
        // Never invented: not in the hello.
        CapabilityOffer {
            name: "camera.capture".into(),
            versions: vec![1],
        },
    ]);
    let msgs = texts(&host.poll());
    assert_eq!(
        msgs[0]["event"]["capabilities"],
        json!([{"name":"core.capabilities","versions":[1]},{"name":"file.save","versions":[1]}])
    );
    host.on_text(
        &request(2, "file.pick", 1024, json!({"accept":[],"maxCount":1})),
        0,
    );
    assert_eq!(error_code(&host.poll(), 2).as_deref(), Some("unsupported"));
}

// ---------------------------------------------------------------------------
// DesktopDevice: dialogs, files, temp files
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ScriptedDialogs {
    picks: Mutex<Option<Vec<PathBuf>>>,
    save_to: Mutex<Option<PathBuf>>,
    /// Hold every dialog until the test releases it.
    gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    unavailable: bool,
    /// How many open panels were shown.
    opened: std::sync::atomic::AtomicUsize,
}

impl FileDialogs for ScriptedDialogs {
    fn available(&self) -> bool {
        !self.unavailable
    }
    fn pick_files(&self, _: &PickDialog) -> Result<Option<Vec<PathBuf>>, DialogUnavailable> {
        self.opened
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(gate) = self.gate.lock().unwrap().take() {
            let _ = gate.recv();
        }
        Ok(self.picks.lock().unwrap().clone())
    }
    fn save_file(&self, _: &SaveDialog) -> Result<Option<PathBuf>, DialogUnavailable> {
        Ok(self.save_to.lock().unwrap().clone())
    }
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hypen-device-unit-{tag}-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Rig {
    device: DesktopDevice,
    rx: mpsc::UnboundedReceiver<DriverMsg>,
    dialogs: Arc<ScriptedDialogs>,
}

impl Rig {
    fn new() -> Self {
        Self::with_ui(None)
    }

    /// A rig whose host UI is a real window-less [`OverlayHub`] (attached
    /// and visible, as under a live window).
    fn with_hub() -> (Self, Arc<OverlayHub>) {
        let hub = Arc::new(OverlayHub::new());
        hub.attach_window(Arc::new(|| {}));
        (Self::with_ui(Some(hub.clone())), hub)
    }

    fn with_ui(ui: Option<Arc<OverlayHub>>) -> Self {
        let dialogs = Arc::new(ScriptedDialogs::default());
        let (tx, rx) = mpsc::unbounded_channel();
        let mut config = DeviceConfig::with_dialogs(dialogs.clone());
        if let Some(ui) = ui {
            config = config.with_capture(ui, Hardware::default());
        }
        let mut device = DesktopDevice::new(&config, tx);
        device.attach("ws://localhost:3000".into());
        let ack = ack_for(device.host());
        device.on_ack(Some(&ack));
        device.on_text(&core_request(1));
        let _ = device.drain();
        Rig {
            device,
            rx,
            dialogs,
        }
    }

    /// Wait for the dialog answer and feed it back.
    fn answer(&mut self) {
        let msg = self.rx.blocking_recv().expect("dialog answer");
        self.device.on_driver(msg);
    }

    fn drain_all(&mut self) -> Vec<WireOut> {
        let mut all = Vec::new();
        loop {
            let outs = self.device.drain();
            let empty = outs.is_empty();
            all.extend(outs);
            if empty && !self.device.has_ready_work() {
                return all;
            }
        }
    }
}

fn wire_texts(outs: &[WireOut]) -> Vec<Value> {
    outs.iter()
        .filter_map(|o| match o {
            WireOut::Text(t) => Some(serde_json::from_str(t).unwrap()),
            _ => None,
        })
        .collect()
}

#[test]
fn file_pick_streams_the_chosen_files_lazily() {
    let dir = scratch("pick");
    let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let path = dir.join("big.dat");
    std::fs::write(&path, &big).unwrap();
    let mut rig = Rig::new();
    *rig.dialogs.picks.lock().unwrap() = Some(vec![path]);
    rig.device.on_text(&request(
        2,
        "file.pick",
        4_000_000,
        json!({"accept":[".dat"],"maxCount":1}),
    ));
    let outs = rig.device.drain();
    assert_eq!(
        wire_texts(&outs)[0]["event"],
        json!({"kind":"progress","state":"pendingConsent"})
    );
    rig.answer();
    let outs = rig.drain_all();
    let bytes: Vec<u8> = outs
        .iter()
        .filter_map(|o| match o {
            WireOut::Binary(f) => Some(f[12..].to_vec()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(bytes, big);
    let msgs = wire_texts(&outs);
    let terminal = msgs.iter().find(|m| m["type"] == "deviceResponse").unwrap();
    assert_eq!(
        terminal["result"]["items"],
        json!([{"channel":0,"name":"big.dat","contentType":"application/octet-stream",
                "bytes":200_000,"sha256":sha(&big)}])
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_late_dialog_answer_after_cancel_uploads_nothing_and_holds_the_prompt() {
    let dir = scratch("late");
    let path = dir.join("x.txt");
    std::fs::write(&path, b"secret").unwrap();
    let mut rig = Rig::new();
    let (release, gate) = std::sync::mpsc::channel();
    *rig.dialogs.gate.lock().unwrap() = Some(gate);
    *rig.dialogs.picks.lock().unwrap() = Some(vec![path]);
    rig.device.on_text(&request(
        2,
        "file.pick",
        65536,
        json!({"accept":[],"maxCount":1}),
    ));
    let _ = rig.device.drain();
    // The server cancels while the OS dialog is open.
    rig.device.on_text(&control(2, json!({"cancel": true})));
    let msgs = wire_texts(&rig.device.drain());
    assert_eq!(msgs[0]["error"]["code"], "cancelled");
    // The dialog is still on screen: no second prompt meanwhile.
    rig.device.on_text(&request(
        3,
        "file.pick",
        65536,
        json!({"accept":[],"maxCount":1}),
    ));
    let msgs = wire_texts(&rig.device.drain());
    assert_eq!(msgs[0]["error"]["code"], "throttled");
    // The user picks after all: nothing is read or sent.
    release.send(()).unwrap();
    rig.answer();
    assert!(rig.drain_all().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn file_save_writes_a_temp_file_and_renames_only_after_verification() {
    let dir = scratch("save");
    let dest = dir.join("out.txt");
    let body: Vec<u8> = (0..300_000u32).map(|i| (i % 7) as u8 + b'a').collect();
    let mut rig = Rig::new();
    *rig.dialogs.save_to.lock().unwrap() = Some(dest.clone());
    let params = json!({"channel":0,"name":"../evil/out.txt","contentType":"text/plain",
                        "bytes":body.len(),"sha256":sha(&body)});
    rig.device.on_text(&request(2, "file.save", 0, params));
    let _ = rig.device.drain();
    rig.answer();
    let msgs = wire_texts(&rig.device.drain());
    // Consent + destination first, then a window of at most 256 KiB.
    let grant = msgs
        .iter()
        .find_map(|m| m["control"]["grant"].as_u64())
        .expect("grant");
    assert_eq!(grant, 256 * 1024);
    let mut sent = 0usize;
    let mut granted = grant as usize;
    let mut seq = 0;
    while sent < body.len() {
        let n = (body.len() - sent).min(65_536).min(granted - sent);
        assert!(n > 0, "the window must keep reopening");
        rig.device.on_frame(&frame(2, seq, &body[sent..sent + n]));
        seq += 1;
        sent += n;
        for m in wire_texts(&rig.device.drain()) {
            if let Some(g) = m["control"]["grant"].as_u64() {
                granted += g as usize;
            }
            if m["type"] == "deviceResponse" {
                assert_eq!(m["result"], json!({"bytesWritten": body.len()}));
            }
        }
        assert!(granted - sent <= 256 * 1024, "outstanding window bounded");
    }
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        1,
        "no temp file left"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_failed_save_deletes_its_temp_file_and_leaves_the_destination_alone() {
    let dir = scratch("save-bad");
    let dest = dir.join("keep.txt");
    std::fs::write(&dest, b"original").unwrap();
    let mut rig = Rig::new();
    *rig.dialogs.save_to.lock().unwrap() = Some(dest.clone());
    let params = json!({"channel":0,"name":"keep.txt","contentType":"text/plain",
                        "bytes":4,"sha256":sha(b"good")});
    rig.device.on_text(&request(2, "file.save", 0, params));
    let _ = rig.device.drain();
    rig.answer();
    let _ = rig.device.drain();
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        2,
        "temp file beside the destination"
    );
    rig.device.on_frame(&frame(2, 0, b"evil"));
    let msgs = wire_texts(&rig.device.drain());
    assert_eq!(msgs[0]["error"]["code"], "invalidParams");
    assert_eq!(std::fs::read(&dest).unwrap(), b"original");
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        1,
        "temp file removed"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn detach_stops_everything_and_ignores_answers_from_the_old_socket() {
    let dir = scratch("detach");
    let dest = dir.join("d.txt");
    let mut rig = Rig::new();
    *rig.dialogs.save_to.lock().unwrap() = Some(dest.clone());
    let params = json!({"channel":0,"name":"d.txt","contentType":"text/plain",
                        "bytes":4,"sha256":sha(b"good")});
    rig.device.on_text(&request(2, "file.save", 0, params));
    let _ = rig.device.drain();
    rig.answer();
    let _ = rig.device.drain();
    rig.device.detach();
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        0,
        "temp file removed on disconnect"
    );
    // A fresh socket starts from scratch: ids restart, the plane waits for
    // its own ack.
    rig.device.attach("ws://localhost:3000".into());
    rig.device.on_text(&core_request(1));
    assert!(
        rig.device.drain().is_empty(),
        "no device traffic before the ack"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn origin_is_scheme_host_and_port() {
    assert_eq!(
        origin_of("wss://App.Example.com:8443/ws?x=1"),
        "wss://app.example.com:8443"
    );
    assert_eq!(origin_of("ws://user@localhost:3000"), "ws://localhost:3000");
    assert_eq!(origin_of("nonsense"), "");
}

// ---------------------------------------------------------------------------
// file.pick / gallery.pick during an OS file drag: the host drop surface
// ---------------------------------------------------------------------------

fn opened(rig: &Rig) -> usize {
    rig.dialogs.opened.load(std::sync::atomic::Ordering::SeqCst)
}

/// The file drop surface currently up, if any.
fn drop_surface(hub: &OverlayHub) -> Option<(ui::SurfaceId, ui::FileDropPrompt)> {
    hub.snapshot().1.into_iter().find_map(|s| match s.surface {
        Surface::FileDrop(p) => Some((s.id, p)),
        _ => None,
    })
}

fn terminal(outs: &[WireOut], id: u32) -> Value {
    wire_texts(outs)
        .into_iter()
        .find(|m| m["type"] == "deviceResponse" && m["id"] == id)
        .unwrap_or_else(|| panic!("no terminal for {id}"))
}

fn pick(rig: &mut Rig, id: u32, capability: &str, params: Value) -> Vec<WireOut> {
    rig.device
        .on_text(&request(id, capability, 4_000_000, params));
    rig.drain_all()
}

#[test]
fn a_pick_during_a_file_drag_shows_the_drop_surface_not_the_os_panel() {
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let outs = pick(&mut rig, 2, "file.pick", json!({"accept":[".txt"],"maxCount":4}));
    assert_eq!(
        wire_texts(&outs)[0]["event"],
        json!({"kind":"progress","state":"pendingConsent"})
    );
    let (_, prompt) = drop_surface(&hub).expect("the host drop surface is up");
    assert_eq!(prompt.origin, "ws://localhost:3000");
    assert_eq!(prompt.capability, "file.pick");
    assert_eq!(prompt.operation, "choose up to 4 files");
    assert!(prompt.multiple);
    assert_eq!(prompt.details, ["Accepts .txt"]);
    // No OS panel, and nothing settled.
    std::thread::sleep(std::time::Duration::from_millis(30));
    assert_eq!(opened(&rig), 0);
    assert!(rig.rx.try_recv().is_err());
    // One prompt at a time: a second pick meanwhile is throttled.
    let outs = pick(&mut rig, 3, "file.pick", json!({"accept":[],"maxCount":1}));
    assert_eq!(terminal(&outs, 3)["error"]["code"], "throttled");
}

#[test]
fn the_grace_window_after_on_file_drag_enter_also_gets_the_drop_surface() {
    let (mut rig, hub) = Rig::with_hub();
    // The drag already left (or flickered), but the app was told about it
    // just now: the pick it answers with still gets the drop surface.
    hub.note_file_drag_signal();
    let _ = pick(&mut rig, 2, "gallery.pick", json!({"mediaTypes":["photo"],"maxCount":1}));
    let (_, prompt) = drop_surface(&hub).expect("drop surface");
    assert_eq!(prompt.operation, "choose a photo or video");
    assert!(!prompt.multiple);
    // A drop released elsewhere ends the grace: the next pick uses the panel.
    hub.set_file_hovering(false, true);
    assert!(!hub.file_drag_in_progress());
}

#[test]
fn files_dropped_on_the_surface_resolve_the_pick_filtered_and_capped() {
    let dir = scratch("drop");
    let a = dir.join("a.txt");
    let b = dir.join("B.TXT");
    let c = dir.join("c.txt");
    let png = dir.join("photo.png");
    let folder = dir.join("folder.txt");
    std::fs::write(&a, b"alpha").unwrap();
    std::fs::write(&b, b"bravo!").unwrap();
    std::fs::write(&c, b"charlie").unwrap();
    std::fs::write(&png, b"\x89PNG").unwrap();
    std::fs::create_dir_all(&folder).unwrap();
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[".txt"],"maxCount":2}));
    let (sid, _) = drop_surface(&hub).expect("drop surface");

    // Only things the panel wouldn't offer: ignored, the surface stays up.
    hub.activate(sid, UiAction::Dropped(vec![png.clone(), folder.clone()]));
    rig.answer();
    assert!(rig.drain_all().is_empty());
    assert!(drop_surface(&hub).is_some(), "still waiting for a drop");

    // The real drop: folder and png skipped by `accept`, cut to maxCount.
    hub.activate(
        sid,
        UiAction::Dropped(vec![folder, png, a.clone(), b.clone(), c]),
    );
    rig.answer();
    let outs = rig.drain_all();
    assert!(drop_surface(&hub).is_none(), "the surface closed");
    assert_eq!(opened(&rig), 0, "no OS panel");
    let res = terminal(&outs, 2);
    assert_eq!(
        res["result"]["items"],
        json!([
            {"channel":0,"name":"a.txt","contentType":"text/plain","bytes":5,"sha256":sha(b"alpha")},
            {"channel":1,"name":"B.TXT","contentType":"text/plain","bytes":6,"sha256":sha(b"bravo!")},
        ])
    );
    // Bytes and names only: no local path ever reaches the wire.
    let dir_str = dir.to_string_lossy().to_string();
    for o in &outs {
        if let WireOut::Text(t) = o {
            assert!(!t.contains(&dir_str), "path leaked: {t}");
        }
    }
    let bytes: Vec<u8> = outs
        .iter()
        .filter_map(|o| match o {
            WireOut::Binary(f) => Some(f[12..].to_vec()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(bytes, b"alphabravo!");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_gallery_drop_keeps_only_the_requested_media_types() {
    let dir = scratch("gdrop");
    let png = dir.join("p.png");
    let mov = dir.join("m.mov");
    std::fs::write(&png, b"img").unwrap();
    std::fs::write(&mov, b"vid").unwrap();
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "gallery.pick", json!({"mediaTypes":["photo"],"maxCount":5}));
    let (sid, _) = drop_surface(&hub).unwrap();
    hub.activate(sid, UiAction::Dropped(vec![mov, png]));
    rig.answer();
    let res = terminal(&rig.drain_all(), 2);
    let items = res["result"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["contentType"], "image/png");
    assert!(items[0].get("name").is_none(), "gallery items carry no name");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn continue_on_the_drop_surface_falls_back_to_the_os_panel() {
    let dir = scratch("cont");
    let f = dir.join("doc.txt");
    std::fs::write(&f, b"hello").unwrap();
    let (mut rig, hub) = Rig::with_hub();
    *rig.dialogs.picks.lock().unwrap() = Some(vec![f]);
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[],"maxCount":1}));
    let (sid, _) = drop_surface(&hub).unwrap();
    hub.activate(sid, UiAction::Continue);
    rig.answer(); // the Continue
    assert!(drop_surface(&hub).is_none(), "the surface closed");
    rig.answer(); // the OS panel's answer
    assert_eq!(opened(&rig), 1);
    let res = terminal(&rig.drain_all(), 2);
    assert_eq!(res["result"]["items"][0]["name"], "doc.txt");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancel_and_escape_on_the_drop_surface_keep_the_consent_semantics() {
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[],"maxCount":1}));
    let (sid, _) = drop_surface(&hub).unwrap();
    hub.activate(sid, UiAction::Cancel);
    rig.answer();
    let res = terminal(&rig.drain_all(), 2);
    assert_eq!(res["error"]["code"], "denied");
    assert!(drop_surface(&hub).is_none());
    assert_eq!(opened(&rig), 0);
    // A refusal cools the capability down (no prompt spam).
    let outs = pick(&mut rig, 3, "file.pick", json!({"accept":[],"maxCount":1}));
    assert_eq!(terminal(&outs, 3)["error"]["code"], "throttled");

    // Escape is abandonment.
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[],"maxCount":1}));
    let (sid, _) = drop_surface(&hub).unwrap();
    hub.activate(sid, UiAction::Dismiss);
    rig.answer();
    assert_eq!(terminal(&rig.drain_all(), 2)["error"]["code"], "cancelled");
    assert!(drop_surface(&hub).is_none());
}

#[test]
fn a_server_cancel_closes_the_drop_surface_and_a_late_drop_sends_nothing() {
    let dir = scratch("dropcancel");
    let f = dir.join("x.txt");
    std::fs::write(&f, b"secret").unwrap();
    let (mut rig, hub) = Rig::with_hub();
    hub.set_file_hovering(true, false);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[],"maxCount":1}));
    let (sid, _) = drop_surface(&hub).unwrap();
    let sink = hub.snapshot().1[0].sink.clone();
    rig.device.on_text(&control(2, json!({"cancel": true})));
    let outs = rig.drain_all();
    assert_eq!(terminal(&outs, 2)["error"]["code"], "cancelled");
    assert!(drop_surface(&hub).is_none(), "the surface closed with the request");
    // A drop racing the cancel (already in the sink) reads and sends nothing.
    sink(UiAction::Dropped(vec![f]));
    rig.answer();
    assert!(rig.drain_all().is_empty());
    let _ = sid;
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn without_a_file_drag_a_pick_opens_the_os_panel_as_before() {
    let dir = scratch("nodrag");
    let f = dir.join("n.txt");
    std::fs::write(&f, b"note").unwrap();
    let (mut rig, hub) = Rig::with_hub();
    *rig.dialogs.picks.lock().unwrap() = Some(vec![f]);
    let _ = pick(&mut rig, 2, "file.pick", json!({"accept":[],"maxCount":1}));
    assert!(drop_surface(&hub).is_none());
    assert!(hub.is_empty(), "no host surface at all");
    rig.answer();
    assert_eq!(opened(&rig), 1);
    let res = terminal(&rig.drain_all(), 2);
    assert_eq!(res["result"]["items"][0]["name"], "n.txt");
    let _ = std::fs::remove_dir_all(dir);
}
