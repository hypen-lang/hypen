//! Device plane tests for the Rust SDK: a real `RemoteSession` driven by a
//! scripted client (the wire as JSON text and binary frames), the shared
//! Rust broker underneath.

use super::*;
use crate::discovery::ComponentRegistry;
use crate::module::ModuleBuilder;
use crate::remote::{ModuleSessionConfig, RemoteSession};
use hypen_engine::serialize::device::{FrameHeader, FRAME_VERSION};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Wire {
    texts: Mutex<Vec<String>>,
    frames: Mutex<Vec<Vec<u8>>>,
    closed: Mutex<Option<(u16, String)>>,
    /// UI messages the session produced on its own (`send_ui`).
    ui: Arc<Mutex<Vec<String>>>,
}

struct WireTransport(Arc<Wire>);

impl SessionTransport for WireTransport {
    fn send_ui(&self, message: String) {
        self.0.ui.lock().unwrap().push(message);
    }
}

impl DeviceTransport for WireTransport {
    fn send_text(&self, text: String) {
        self.0.texts.lock().unwrap().push(text);
    }
    fn send_binary(&self, frame: Vec<u8>) {
        self.0.frames.lock().unwrap().push(frame);
    }
    fn close(&self, code: u16, reason: &str) {
        *self.0.closed.lock().unwrap() = Some((code, reason.to_string()));
    }
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
struct S {
    result: String,
    events: Vec<String>,
}

const ALL: &[&str] = &[
    "core.capabilities",
    "file.pick",
    "file.save",
    "gallery.pick",
    "permission.query",
    "bluetooth.scan",
    "mic.record",
];

fn hello_device(caps: &[&str]) -> Value {
    json!({
        "protocolVersions": [1],
        "binary": true,
        "capabilities": caps.iter().map(|c| json!({"name": c, "versions": [1]})).collect::<Vec<_>>(),
    })
}

fn set(s: &mut S, r: String) {
    s.result = r;
}

fn module() -> Arc<crate::module::ModuleDefinition<S>> {
    Arc::new(
        ModuleBuilder::<S>::new("App")
            .state(S::default())
            .ui(r#"Column { Text("@{state.result}") }"#)
            .on_action::<()>("supports", |s, _, ctx| {
                let d = ctx.unwrap().device();
                s.result = format!(
                    "{}|{}|{}|{:?}",
                    d.supports("file.pick"),
                    d.supports("camera.capture"),
                    d.is_enabled(),
                    d.selected_version("file.save")
                );
            })
            .on_action::<()>("pick", |s, _, ctx| {
                match ctx.unwrap().device().file_pick(&[".txt"], 2) {
                    Ok(call) => call.then(|s: &mut S, r| {
                        set(
                            s,
                            match r {
                                Ok(items) => items
                                    .iter()
                                    .map(|b| {
                                        format!(
                                            "{}:{}:{}",
                                            b.name.clone().unwrap_or_default(),
                                            b.content_type,
                                            String::from_utf8_lossy(&b.bytes)
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join(","),
                                Err(e) => format!("err:{}", e.code_str()),
                            },
                        )
                    }),
                    Err(e) => {
                        s.result =
                            format!("refused:{}:{}", e.code_str(), e.detail.unwrap_or_default())
                    }
                }
            })
            .on_action::<()>("camera", |s, _, ctx| {
                let d = ctx.unwrap().device();
                match d.camera_capture(CameraCaptureParams {
                    mode: CaptureMode::Photo,
                    facing: None,
                    max_duration_ms: None,
                }) {
                    Ok(call) => {
                        call.cancel();
                        s.result = "sent".into();
                    }
                    Err(e) => s.result = format!("refused:{}", e.code_str()),
                }
            })
            .on_action::<()>("save", |s, _, ctx| {
                let bytes: Vec<u8> = (0..100_000u32).map(|i| (i % 250) as u8).collect();
                match ctx
                    .unwrap()
                    .device()
                    .save("r.bin", "application/octet-stream", bytes)
                {
                    Ok(call) => call.then(|s: &mut S, r| {
                        s.result = match r {
                            Ok(rcpt) => format!("saved:{}", rcpt.bytes_written),
                            Err(e) => format!("err:{}", e.code_str()),
                        }
                    }),
                    Err(e) => s.result = format!("refused:{}", e.code_str()),
                }
            })
            .on_action::<()>("orphan", |s, _, ctx| {
                // Dropped without a consumer: the request is cancelled.
                let _ = ctx.unwrap().device().file_pick(&[], 1);
                s.result = "orphaned".into();
            })
            .on_action::<()>("wait", |s, _, ctx| {
                s.result = match ctx.unwrap().device().file_pick(&[], 1) {
                    Ok(call) => match call.wait() {
                        Ok(_) => "unexpected".into(),
                        Err(e) => format!("{}:{}", e.code_str(), e.detail.unwrap_or_default()),
                    },
                    Err(e) => format!("refused:{}", e.code_str()),
                };
            })
            .on_action::<()>("slow", |s, _, ctx| {
                let opts = RequestOptions {
                    timeout: Some(Duration::from_millis(150)),
                    ..Default::default()
                };
                match ctx.unwrap().device().request_with(
                    "permission.query",
                    json!({"permission": "camera"}),
                    opts,
                ) {
                    Ok(call) => call.then(|s: &mut S, r| {
                        s.result = match r {
                            Ok(_) => "ok".into(),
                            Err(e) => format!("err:{}", e.code_str()),
                        }
                    }),
                    Err(e) => s.result = format!("refused:{}", e.code_str()),
                }
            })
            .on_action::<()>("query", |s, _, ctx| {
                match ctx.unwrap().device().permission_query(Permission::Camera) {
                    Ok(call) => call.then(|s: &mut S, r| {
                        s.result = match r {
                            Ok(status) => format!("{:?}:{}", *status, status.simulated),
                            Err(e) => format!("err:{}", e.code_str()),
                        }
                    }),
                    Err(e) => s.result = format!("refused:{}", e.code_str()),
                }
            })
            .on_action::<()>("scan", |s, _, ctx| {
                match ctx.unwrap().device().bluetooth_scan() {
                    Ok(stream) => {
                        stream.for_each(|s: &mut S, item| match item {
                            StreamItem::Event(e) => s
                                .events
                                .push(e["device"]["id"].as_str().unwrap_or("?").to_string()),
                            StreamItem::End(r) => {
                                s.result = match r {
                                    Ok(_) => "ended".into(),
                                    Err(e) => format!("ended:{}", e.code_str()),
                                }
                            }
                            StreamItem::Data { .. } => {}
                        });
                    }
                    Err(e) => s.result = format!("refused:{}", e.code_str()),
                }
            })
            .build(),
    )
}

struct Rig {
    session: Arc<RemoteSession>,
    wire: Arc<Wire>,
    ui: Arc<Mutex<Vec<String>>>,
    seen: usize,
}

/// A fresh server-wide settings object (tests do not share the process
/// default's resume tokens).
fn server() -> Arc<DeviceServer> {
    DeviceServer::new(DeviceServerConfig::default())
}

impl Rig {
    /// A session built for a connection, the way a server builds one: the
    /// transport at construction and nothing else — no enable call.
    fn with_server(server: &Arc<DeviceServer>) -> Rig {
        let wire = Arc::new(Wire::default());
        let session = Arc::new(
            RemoteSession::connect(
                module(),
                ComponentRegistry::new(),
                Arc::new(WireTransport(Arc::clone(&wire))),
            )
            .with_device_server(server),
        );
        let ui = Arc::clone(&wire.ui);
        Rig {
            session,
            wire,
            ui,
            seen: 0,
        }
    }

    fn new() -> Rig {
        Rig::with_server(&server())
    }

    /// Send the hello; returns the sessionAck.
    fn hello(
        &mut self,
        device: Option<Value>,
        session_id: Option<&str>,
        token: Option<&str>,
    ) -> Value {
        let mut hello = json!({"type": "hello"});
        if let Some(d) = device {
            hello["device"] = d;
        }
        if let Some(id) = session_id {
            hello["sessionId"] = json!(id);
        }
        if let Some(t) = token {
            hello["resumeToken"] = json!(t);
        }
        let out = self.session.handle_message(&hello.to_string());
        let ack: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(ack["type"], "sessionAck");
        ack
    }

    fn connect(&mut self, caps: &[&str]) -> Value {
        let ack = self.hello(Some(hello_device(caps)), None, None);
        // The core stream is the first device request.
        let core = self.next("core.capabilities");
        let id = core["id"].as_u64().unwrap();
        self.send(json!({"type":"deviceEvent","id":id,"event":{"capabilities":
            caps.iter().map(|c| json!({"name": c, "versions": [1]})).collect::<Vec<_>>()}}));
        ack
    }

    fn send(&self, v: Value) -> Vec<String> {
        self.session.handle_message(&v.to_string())
    }

    fn dispatch(&self, action: &str) -> Vec<String> {
        self.send(json!({"type":"dispatchAction","module":"App","action":action}))
    }

    /// New device texts since the last call, lease renewals acknowledged.
    fn drain(&mut self) -> Vec<Value> {
        let texts: Vec<String> = {
            let t = self.wire.texts.lock().unwrap();
            let new = t[self.seen..].to_vec();
            self.seen = t.len();
            new
        };
        let mut out = Vec::new();
        for t in texts {
            let v: Value = serde_json::from_str(&t).unwrap();
            if let Some(seq) = v["control"].get("renewLease") {
                self.send(json!({"type":"deviceEvent","id":v["id"],"control":{"leaseAck":seq}}));
                continue;
            }
            out.push(v);
        }
        out
    }

    /// The next device request for `capability` (fails if none is sent).
    fn next(&mut self, capability: &str) -> Value {
        self.drain()
            .into_iter()
            .find(|v| v["type"] == "deviceRequest" && v["capability"] == capability)
            .unwrap_or_else(|| panic!("no {capability} request on the wire"))
    }

    fn frame(&self, id: u64, channel: u16, seq: u32, payload: &[u8]) {
        let mut f = FrameHeader {
            version: FRAME_VERSION,
            flags: 0,
            channel,
            request_id: id as u32,
            seq,
        }
        .encode()
        .to_vec();
        f.extend_from_slice(payload);
        self.session.handle_binary(&f);
    }

    fn result(&self) -> String {
        self.session.get_state()["result"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    fn wait_result(&self, want_prefix: &str) -> String {
        let start = Instant::now();
        loop {
            let r = self.result();
            if r.starts_with(want_prefix) {
                return r;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "waiting for {want_prefix}: {r}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn sha(b: &[u8]) -> String {
    hypen_engine::device::sha256_hex(b)
}

// ---------------------------------------------------------------------------
// handshake, admission, resume
// ---------------------------------------------------------------------------

#[test]
fn without_a_device_hello_every_call_is_device_disabled() {
    let mut rig = Rig::new();
    let ack = rig.hello(None, None, None);
    assert!(ack.get("device").is_none());
    assert!(
        ack["resumeToken"].is_string(),
        "with the device plane on (the default) every ack rotates a token"
    );
    rig.dispatch("supports");
    assert_eq!(rig.result(), "false|false|false|None");
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unavailable:device-disabled");
    assert!(
        rig.wire.texts.lock().unwrap().is_empty(),
        "no device traffic"
    );
}

#[test]
fn a_session_without_a_transport_is_ui_only() {
    // In-process / test form: no connection to carry device traffic.
    let session = RemoteSession::from_definition(module(), ComponentRegistry::new());
    let out = session.handle_message(
        &json!({"type":"hello","device": hello_device(&["core.capabilities","file.pick"])})
            .to_string(),
    );
    let ack: Value = serde_json::from_str(&out[0]).unwrap();
    assert!(ack.get("device").is_none() && ack.get("resumeToken").is_none());
    session.handle_message(r#"{"type":"dispatchAction","module":"App","action":"pick"}"#);
    assert_eq!(
        session.get_state()["result"],
        "refused:unavailable:device-disabled"
    );
}

#[test]
fn the_handshake_selects_opens_core_first_and_follows_snapshots() {
    let mut rig = Rig::new();
    let ack = rig.hello(Some(hello_device(ALL)), None, None);
    let device = &ack["device"];
    assert_eq!(device["protocolVersion"], 1);
    assert_eq!(device["binary"], true);
    let names: Vec<&str> = device["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"core.capabilities") && names.contains(&"file.pick"));
    let first = rig.drain();
    assert_eq!(
        first[0]["capability"], "core.capabilities",
        "core.capabilities opens first"
    );
    assert_eq!(first[0]["owner"], json!({"connection": true}));
    assert!(rig.session.device_enabled());
    rig.dispatch("supports");
    assert_eq!(rig.result(), "true|false|true|Some(1)");
    // A snapshot withdrawing file.pick removes it from the live selection.
    let core = first[0]["id"].clone();
    rig.send(
        json!({"type":"deviceEvent","id":core,"event":{"capabilities":[
        {"name":"core.capabilities","versions":[1]},{"name":"file.save","versions":[1]}]}}),
    );
    rig.dispatch("supports");
    assert_eq!(rig.result(), "false|false|true|Some(1)");
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unsupported:");
}

#[test]
fn invalid_or_duplicated_hello_device_disables_the_plane() {
    for hello in [
        r#"{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"file.pick","versions":[1]}]}}"#,
        r#"{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]},{"name":"core.capabilities","versions":[1]}]}}"#,
        r#"{"type":"hello","device":{"protocolVersions":[1.0],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}}"#,
        r#"{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]},"device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}}"#,
    ] {
        let rig = Rig::new();
        let out = rig.session.handle_message(hello);
        let ack: Value = serde_json::from_str(&out[0]).unwrap();
        assert!(ack.get("device").is_none(), "{hello}");
        assert!(!rig.session.device_enabled());
    }
}

#[test]
fn selection_fixtures_through_the_session_hello() {
    // Every selection case's hello, sent as a real `hello` message: the
    // session acks exactly the shared Rust selection for this server
    // (the broker's advertisement, binary routing, protocol v1), invalid
    // hellos included; where the case's server is that server, the ack is
    // the fixture's expectation.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/conformance/selection.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let advertised: Vec<Value> = hypen_engine::device::server_advertisement()
        .into_iter()
        .map(|o| serde_json::to_value(o).unwrap())
        .collect();
    let (mut total, mut exact) = (0, 0);
    for case in doc["cases"].as_array().unwrap() {
        let rig = Rig::new();
        let out = rig
            .session
            .handle_message(&json!({"type":"hello","device":case["hello"]}).to_string());
        let ack: Value = serde_json::from_str(&out[0]).unwrap();
        let got = ack.get("device").cloned().unwrap_or(Value::Null);
        let reference =
            hypen_engine::device::negotiate_explained(&case["hello"].to_string(), true, None)
                .ok()
                .map(|a| serde_json::to_value(a).unwrap())
                .unwrap_or(Value::Null);
        assert_eq!(got, reference, "{}", case["name"]);
        assert_eq!(rig.session.device_enabled(), !got.is_null());
        total += 1;
        let server_caps = case["serverCapabilities"].as_array().unwrap();
        let protocols = case
            .get("serverProtocolVersions")
            .cloned()
            .unwrap_or(json!([1]));
        if server_caps == &advertised && case["serverBinary"] == true && protocols == json!([1]) {
            assert_eq!(got, case["expect"], "{}", case["name"]);
            exact += 1;
        }
    }
    assert!(total >= 20 && exact >= 1, "{total} {exact}");
}

#[test]
fn selection_fixtures_through_negotiate() {
    // Every selection case whose server side is the broker's (binary
    // routing, v1): `negotiate_explained` with the case's advertisement.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/conformance/selection.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut checked = 0;
    for case in doc["cases"].as_array().unwrap() {
        let protocols = case
            .get("serverProtocolVersions")
            .cloned()
            .unwrap_or(json!([1]));
        if protocols != json!([1]) {
            continue;
        }
        let server: Vec<hypen_engine::serialize::device::CapabilityOffer> =
            serde_json::from_value(case["serverCapabilities"].clone()).unwrap();
        let got = hypen_engine::device::negotiate_explained(
            &case["hello"].to_string(),
            case["serverBinary"] == true,
            Some(&server),
        )
        .ok()
        .map(|a| serde_json::to_value(a).unwrap())
        .unwrap_or(Value::Null);
        assert_eq!(got, case["expect"], "{}", case["name"]);
        checked += 1;
    }
    assert!(checked >= 20, "{checked}");
}

#[test]
fn resume_needs_the_latest_token() {
    let server = server();
    let mut first = Rig::with_server(&server);
    let ack = first.connect(ALL);
    let id = ack["sessionId"].as_str().unwrap().to_string();
    let token = ack["resumeToken"].as_str().unwrap().to_string();
    drop(first);

    // Wrong token: a new session, never a takeover.
    let mut wrong = Rig::with_server(&server);
    let ack = wrong.hello(Some(hello_device(ALL)), Some(&id), Some("forged"));
    assert_eq!(ack["isNew"], true);
    assert_ne!(ack["sessionId"], json!(id));

    // The issued token resumes, and rotates.
    let mut right = Rig::with_server(&server);
    let ack = right.hello(Some(hello_device(ALL)), Some(&id), Some(&token));
    assert_eq!(ack["isRestored"], true);
    assert_eq!(ack["sessionId"], json!(id));
    assert_ne!(ack["resumeToken"], json!(token));
    assert!(ack["device"].is_object(), "a fresh device plane");
    assert!(!server.verify_resume(&id, Some(&token)));
}

#[test]
fn legacy_ui_only_sessions_resume_by_id_but_device_sessions_need_the_token() {
    let server = server();
    // A legacy client (no `device` in its hello) on a device-on server:
    // its ack still carries a token, but the id alone resumes it.
    let mut legacy = Rig::with_server(&server);
    let ack = legacy.hello(None, None, None);
    assert!(ack.get("device").is_none() && ack["resumeToken"].is_string());
    let ui_id = ack["sessionId"].as_str().unwrap().to_string();
    drop(legacy);
    let mut again = Rig::with_server(&server);
    let ack = again.hello(None, Some(&ui_id), None);
    assert_eq!(ack["isRestored"], true, "{ack}");
    assert_eq!(ack["sessionId"], json!(ui_id));
    assert!(!server.requires_resume_token(&ui_id));

    // A session that negotiated a device plane: id alone is a new session,
    // even from a hello that offers no device.
    let mut dev = Rig::with_server(&server);
    let ack = dev.connect(ALL);
    let dev_id = ack["sessionId"].as_str().unwrap().to_string();
    let token = ack["resumeToken"].as_str().unwrap().to_string();
    assert!(server.requires_resume_token(&dev_id));
    drop(dev);
    let mut id_only = Rig::with_server(&server);
    let ack = id_only.hello(None, Some(&dev_id), None);
    assert_eq!(ack["isNew"], true);
    assert_ne!(ack["sessionId"], json!(dev_id));
    let mut with_token = Rig::with_server(&server);
    let ack = with_token.hello(None, Some(&dev_id), Some(&token));
    assert_eq!(ack["isRestored"], true);
    assert_eq!(ack["sessionId"], json!(dev_id));
}

#[test]
fn dispatch_before_hello_is_dropped_and_legacy_hosts_still_hello_for_the_client() {
    let rig = Rig::new();
    assert!(rig.dispatch("supports").is_empty());
    assert_eq!(rig.result(), "");
    // No watchdog closes a silent socket any more: a host serving a legacy
    // client that never sends hello initialises it itself (the grace
    // path), and that session simply has no device plane.
    std::thread::sleep(Duration::from_millis(150));
    assert!(rig.wire.closed.lock().unwrap().is_none());
    let out = rig.session.handle_hello(None);
    let ack: Value = serde_json::from_str(&out[0]).unwrap();
    assert!(ack.get("device").is_none());
    assert!(!rig.session.device_enabled());
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unavailable:device-disabled");
}

#[test]
fn the_plane_needs_no_call_and_no_server_configuration() {
    // Only the transport: the process-wide default server, no admission
    // configured, no enable call.
    let wire = Arc::new(Wire::default());
    let session = RemoteSession::connect(
        module(),
        ComponentRegistry::new(),
        Arc::new(WireTransport(Arc::clone(&wire))),
    );
    let out = session.handle_message(
        &json!({"type":"hello","device": hello_device(&["core.capabilities","file.pick"])})
            .to_string(),
    );
    let ack: Value = serde_json::from_str(&out[0]).unwrap();
    assert!(ack["device"].is_object(), "{ack}");
    assert!(ack["resumeToken"].is_string());
    assert!(session.device_enabled());
    assert!(wire
        .texts
        .lock()
        .unwrap()
        .iter()
        .any(|t| t.contains("core.capabilities")));
    session.handle_close();
}

#[test]
fn disable_device_is_the_one_opt_out() {
    // Server-wide.
    let off = server();
    off.disable_device();
    let mut rig = Rig::with_server(&off);
    let ack = rig.hello(Some(hello_device(ALL)), None, None);
    assert!(ack.get("device").is_none() && ack.get("resumeToken").is_none());
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unavailable:device-disabled");
    assert!(rig.wire.texts.lock().unwrap().is_empty());

    // Per connection, before the hello.
    let mut one = Rig::new();
    one.session.disable_device().unwrap();
    let ack = one.hello(Some(hello_device(ALL)), None, None);
    assert!(ack.get("device").is_none() && ack.get("resumeToken").is_none());
    assert!(one.wire.texts.lock().unwrap().is_empty());
    assert!(
        one.session.disable_device().is_err(),
        "after the hello it is too late"
    );
}

#[test]
fn configure_device_options_reach_new_connections() {
    let server = server();
    server.configure_device(DeviceOptions {
        max_item_bytes: Some(4),
        ..DeviceOptions::default()
    });
    let mut rig = Rig::with_server(&server);
    rig.connect(ALL);
    rig.dispatch("pick");
    let req = rig.next("file.pick");
    let id = req["id"].as_u64().unwrap();
    // A 10-byte item is over the configured 4-byte cap: the upload is
    // refused, never delivered as a success.
    rig.send(
        json!({"type":"deviceEvent","id":id,"event":{"kind":"blobStart","channel":0,
        "contentType":"text/plain","bytes":10,"name":"a.txt"}}),
    );
    rig.frame(id, 0, 0, b"0123456789");
    rig.send(
        json!({"type":"deviceResponse","id":id,"result":{"items":[{"channel":0,
        "contentType":"text/plain","bytes":10,"name":"a.txt","sha256":sha(b"0123456789")}]}}),
    );
    let r = rig.wait_result("err:");
    assert!(r.starts_with("err:"), "{r}");
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

#[test]
fn file_pick_uploads_are_verified_and_applied_to_state() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    let req = rig.next("file.pick");
    let id = req["id"].as_u64().unwrap();
    assert_eq!(req["owner"]["activationId"], 1);
    assert_eq!(req["lifetime"], "activation");
    assert_eq!(req["params"], json!({"accept": [".txt"], "maxCount": 2}));
    let (a, b) = (b"hello".to_vec(), b"world!!".to_vec());
    rig.send(json!({"type":"deviceEvent","id":id,"event":{"kind":"blobStart","channel":0,"contentType":"text/plain","bytes":5}}));
    rig.send(json!({"type":"deviceEvent","id":id,"event":{"kind":"blobStart","channel":1,"contentType":"text/plain","bytes":7}}));
    rig.frame(id, 0, 0, &a);
    rig.frame(id, 1, 0, &b);
    let ui_before = rig.ui.lock().unwrap().len();
    rig.send(json!({"type":"deviceResponse","id":id,"result":{"items":[
        {"channel":0,"name":"a.txt","contentType":"text/plain","bytes":5,"sha256":sha(&a)},
        {"channel":1,"name":"b.txt","contentType":"text/plain","bytes":7,"sha256":sha(&b)}]}}));
    assert_eq!(
        rig.result(),
        "a.txt:text/plain:hello,b.txt:text/plain:world!!"
    );
    // The state change shipped as a patch through the UI sink.
    let ui = rig.ui.lock().unwrap();
    assert!(
        ui[ui_before..]
            .iter()
            .any(|m| m.contains("\"type\":\"patch\"")),
        "{ui:?}"
    );
}

#[test]
fn a_hash_mismatch_never_reaches_the_handler_as_success() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    let id = rig.next("file.pick")["id"].as_u64().unwrap();
    rig.send(json!({"type":"deviceEvent","id":id,"event":{"kind":"blobStart","channel":0,"contentType":"text/plain","bytes":5}}));
    rig.frame(id, 0, 0, b"hello");
    rig.send(json!({"type":"deviceResponse","id":id,"result":{"items":[
        {"channel":0,"name":"a.txt","contentType":"text/plain","bytes":5,"sha256":sha(b"HELLO")}]}}));
    assert_eq!(rig.result(), "err:invalidParams");
}

#[test]
fn local_refusals_are_immediate_values() {
    let mut rig = Rig::new();
    rig.connect(&["core.capabilities", "file.pick"]);
    // Not negotiated: unsupported, nothing sent.
    rig.dispatch("camera");
    assert_eq!(rig.result(), "refused:unsupported");
    assert!(rig.drain().is_empty());
}

#[test]
fn client_errors_and_simulated_results_reach_the_handler() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    let id = rig.next("file.pick")["id"].clone();
    rig.send(json!({"type":"deviceResponse","id":id,"error":{"code":"denied","platformDetail":"user-declined"}}));
    assert_eq!(rig.result(), "err:denied");
    rig.dispatch("query");
    let id = rig.next("permission.query")["id"].clone();
    rig.send(
        json!({"type":"deviceResponse","id":id,"result":{"status":"granted"},"simulated":true}),
    );
    assert_eq!(rig.result(), "Granted:true");
}

#[test]
fn an_unconsumed_call_is_cancelled_and_wait_is_refused_in_a_handler() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("orphan");
    let msgs = rig.drain();
    let req = msgs.iter().find(|m| m["type"] == "deviceRequest").unwrap();
    assert!(
        msgs.iter()
            .any(|m| m["id"] == req["id"] && m["control"] == json!({"cancel": true})),
        "{msgs:?}"
    );
    rig.dispatch("wait");
    assert!(
        rig.result().starts_with("unavailable:wait-in-handler"),
        "{}",
        rig.result()
    );
    let msgs = rig.drain();
    assert!(msgs.iter().any(|m| m["control"] == json!({"cancel": true})));
}

#[test]
fn deadlines_settle_through_the_timer_thread() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    let ui_before = rig.ui.lock().unwrap().len();
    rig.dispatch("slow");
    let req = rig.next("permission.query");
    assert_eq!(req["timeoutMs"], 150);
    assert_eq!(rig.wait_result("err:"), "err:timeout");
    // The server cancels on its own deadline (the client may race it).
    let msgs = rig.drain();
    assert!(msgs
        .iter()
        .any(|m| m["id"] == req["id"] && m["control"] == json!({"cancel": true})));
    let ui = rig.ui.lock().unwrap();
    assert!(
        ui[ui_before..]
            .iter()
            .any(|m| m.contains("\"type\":\"patch\"")),
        "patch via the sink"
    );
}

#[test]
fn file_save_downloads_within_client_credit() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("save");
    let req = rig.next("file.save");
    let id = req["id"].as_u64().unwrap();
    assert_eq!(req["initialCredit"], 0);
    assert_eq!(req["params"]["bytes"], 100_000);
    assert!(
        rig.wire.frames.lock().unwrap().is_empty(),
        "nothing before a grant"
    );
    rig.send(json!({"type":"deviceEvent","id":id,"control":{"grant":100_000}}));
    let start = Instant::now();
    let mut body = Vec::new();
    while body.len() < 100_000 {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "{} bytes",
            body.len()
        );
        let frames: Vec<Vec<u8>> = std::mem::take(&mut *rig.wire.frames.lock().unwrap());
        for f in frames {
            let (h, p) = FrameHeader::decode(&f).unwrap();
            assert_eq!(h.request_id as u64, id);
            body.extend_from_slice(p);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(sha(&body), req["params"]["sha256"].as_str().unwrap());
    rig.send(json!({"type":"deviceResponse","id":id,"result":{"bytesWritten":100_000}}));
    assert_eq!(rig.result(), "saved:100000");
}

#[test]
fn streams_deliver_events_in_order_then_end() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("scan");
    let id = rig.next("bluetooth.scan")["id"].clone();
    for (i, rssi) in [-40, -50].iter().enumerate() {
        rig.send(json!({"type":"deviceEvent","id":id,"event":{"device":{"id":format!("d{i}"),"rssi":rssi}}}));
    }
    assert_eq!(rig.session.get_state()["events"], json!(["d0", "d1"]));
    rig.send(json!({"type":"deviceResponse","id":id,"result":{}}));
    assert_eq!(rig.result(), "ended");
}

#[test]
fn deactivation_sweeps_and_a_stale_scope_is_refused() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    let req = rig.next("file.pick");
    rig.session.deactivate_module(None);
    assert_eq!(rig.result(), "err:cancelled");
    let msgs = rig.drain();
    assert!(msgs
        .iter()
        .any(|m| m["id"] == req["id"] && m["control"] == json!({"cancel": true})));
    // Still inactive: new work is refused.
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unavailable:owner-inactive");
    // A new activation works again, under a higher activationId.
    rig.session.activate_module(None);
    rig.dispatch("pick");
    assert_eq!(rig.next("file.pick")["owner"]["activationId"], 2);
}

/// A routed app: `/` shows Camera, `/other` shows Other (both nested
/// modules with device actions that log what they get).
fn routed_rig(log: Arc<Mutex<Vec<String>>>) -> Rig {
    fn routed_module(
        name: &'static str,
        action: &'static str,
        log: Arc<Mutex<Vec<String>>>,
    ) -> ModuleSessionConfig {
        let def = ModuleBuilder::<S>::new(name)
            .state(S::default())
            .on_action::<()>(action, move |_, _, ctx| {
                let d = ctx.unwrap().device();
                let log = Arc::clone(&log);
                match d.file_pick(&[], 1) {
                    Ok(call) => {
                        let tag = format!("{action}:");
                        call.on_settled(move |r| {
                            log.lock().unwrap().push(match r {
                                Ok(_) => format!("{tag}ok"),
                                Err(e) => format!("{tag}{}", e.code_str()),
                            })
                        })
                    }
                    Err(e) => log
                        .lock()
                        .unwrap()
                        .push(format!("{action}:refused:{}", e.detail.unwrap_or_default())),
                }
            })
            .build();
        ModuleSessionConfig::from_definition(Arc::new(def))
    }
    let ui = r#"Column {
        Router {
            Route(path: "/") { Camera() }
            Route(path: "/other") { Other() }
        }
    }"#;
    let app = Arc::new(
        ModuleBuilder::<S>::new("App")
            .state(S::default())
            .ui(ui)
            .build(),
    );
    let mut components = ComponentRegistry::new();
    components.register("Camera", r#"module Camera { Text("camera") }"#, None);
    components.register("Other", r#"module Other { Text("other") }"#, None);
    let wire = Arc::new(Wire::default());
    let session = Arc::new(
        RemoteSession::connect_with_state(
            app,
            components,
            S::default(),
            vec![
                routed_module("Camera", "camPick", Arc::clone(&log)),
                routed_module("Other", "otherPick", log),
            ],
            Arc::new(WireTransport(Arc::clone(&wire))),
        )
        .with_device_server(&server()),
    );
    let ui = Arc::clone(&wire.ui);
    Rig {
        session,
        wire,
        ui,
        seen: 0,
    }
}

/// Navigation moves device activation with the screen, like the other
/// SDKs' routers: leaving a route ends its module's activation (in-flight
/// activation-owned work is cancelled on the wire, a later request from it
/// is refused `owner-inactive`), and entering a route starts a new one.
#[test]
fn navigation_deactivates_the_module_that_left_the_screen() {
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut rig = routed_rig(Arc::clone(&log));
    rig.connect(ALL);
    let push = |rig: &Rig, to: &str| {
        rig.send(json!({"type":"dispatchAction","module":"App","action":"router.push","payload":{"to":to}}));
    };

    // `/`: Camera is on screen (activation 1).
    rig.dispatch("camPick");
    let req = rig.next("file.pick");
    assert!(req["owner"]["moduleInstanceId"]
        .as_str()
        .unwrap()
        .starts_with("camera@"));
    assert_eq!(req["owner"]["activationId"], 1);
    // Other is off screen: not activated yet.
    rig.dispatch("otherPick");
    assert_eq!(
        log.lock().unwrap().pop().as_deref(),
        Some("otherPick:refused:owner-inactive")
    );

    // Navigate away: Camera's pick is cancelled on the wire and settles
    // cancelled; Other gets its first activation.
    push(&rig, "/other");
    let msgs = rig.drain();
    assert!(
        msgs.iter()
            .any(|m| m["id"] == req["id"] && m["control"] == json!({"cancel": true})),
        "{msgs:?}"
    );
    assert_eq!(
        log.lock().unwrap().pop().as_deref(),
        Some("camPick:cancelled")
    );
    rig.dispatch("camPick");
    assert_eq!(
        log.lock().unwrap().pop().as_deref(),
        Some("camPick:refused:owner-inactive")
    );
    rig.dispatch("otherPick");
    let other = rig.next("file.pick");
    assert!(other["owner"]["moduleInstanceId"]
        .as_str()
        .unwrap()
        .starts_with("other@"));
    assert_eq!(other["owner"]["activationId"], 1);

    // Back: Camera starts a NEW activation; Other's work is swept.
    push(&rig, "/");
    let msgs = rig.drain();
    assert!(msgs
        .iter()
        .any(|m| m["id"] == other["id"] && m["control"] == json!({"cancel": true})));
    assert_eq!(
        log.lock().unwrap().pop().as_deref(),
        Some("otherPick:cancelled")
    );
    rig.dispatch("camPick");
    assert_eq!(rig.next("file.pick")["owner"]["activationId"], 2);

    // The host driving the router directly (e.g. a ManagedRouter) moves
    // activation the same way.
    rig.session.router().push("/other");
    assert_eq!(
        log.lock().unwrap().pop().as_deref(),
        Some("camPick:cancelled")
    );
}

#[test]
fn agent_dispatches_cannot_open_device_work() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.session.dispatch_external("pick", None).unwrap();
    assert_eq!(rig.result(), "refused:unavailable:syncActions.replay");
    assert!(rig.drain().iter().all(|m| m["type"] != "deviceRequest"));
    // The user's own click still works.
    rig.dispatch("pick");
    rig.next("file.pick");
}

#[test]
fn host_side_device_handles_apply_to_their_module() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    let device = rig.session.device(None);
    assert!(device.supports("file.pick"));
    let call = device.permission_query(Permission::Microphone).unwrap();
    call.then(|s: &mut S, r| s.result = format!("host:{:?}", r.map(|d| d.value)));
    let id = rig.next("permission.query")["id"].clone();
    rig.send(json!({"type":"deviceResponse","id":id,"result":{"status":"denied"}}));
    assert_eq!(rig.result(), "host:Ok(Denied)");
    // wait() from a thread that is not a handler.
    let call = rig
        .session
        .device(None)
        .permission_query(Permission::Camera)
        .unwrap();
    let waiter = std::thread::spawn(move || call.wait());
    let id = loop {
        if let Some(r) = rig
            .drain()
            .into_iter()
            .find(|m| m["type"] == "deviceRequest")
        {
            break r["id"].clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    rig.send(json!({"type":"deviceResponse","id":id,"result":{"status":"prompt"}}));
    assert_eq!(*waiter.join().unwrap().unwrap(), PermissionStatus::Prompt);
}

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

#[test]
fn the_shared_message_corpus_never_disturbs_the_ui_path() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/conformance/messages.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut rig = Rig::new();
    rig.connect(ALL);
    let mut fed = 0usize;
    for section in ["valid", "invalid"] {
        for case in doc[section].as_array().unwrap() {
            let text = if let Some(m) = case.get("message") {
                m.to_string()
            } else if let Some(raw) = case.get("raw").and_then(Value::as_str) {
                raw.to_string()
            } else if let Some(hex) = case.get("rawHex").and_then(Value::as_str) {
                let bytes: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                    .collect();
                match String::from_utf8(bytes) {
                    Ok(s) => s,
                    Err(_) => continue, // not deliverable as a text frame
                }
            } else if let Some(r) = case.get("rawRepeat") {
                format!(
                    "{}{}{}",
                    r["prefix"].as_str().unwrap(),
                    r["repeat"]
                        .as_str()
                        .unwrap()
                        .repeat(r["count"].as_u64().unwrap() as usize),
                    r["suffix"].as_str().unwrap()
                )
            } else {
                continue;
            };
            // Device text never produces a UI reply.
            assert!(
                rig.session.handle_message(&text).is_empty(),
                "{}",
                case["name"]
            );
            fed += 1;
        }
    }
    assert!(fed > 200, "{fed}");
    // The UI path is untouched; the plane may have closed after repeated
    // connection-level abuse (RFC 001 §2.1), in which case it asked for the
    // socket reset.
    if !rig.session.device_enabled() {
        assert_eq!(
            rig.wire.closed.lock().unwrap().as_ref().unwrap().0,
            DEVICE_PLANE_CLOSE_CODE
        );
    }
    let replies = rig.dispatch("supports");
    assert!(
        replies.iter().any(|m| m.contains("\"type\":\"patch\"")),
        "{replies:?}"
    );
}

#[test]
fn connection_level_abuse_closes_the_device_plane_only() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    rig.next("file.pick");
    for _ in 0..64 {
        rig.session
            .handle_message(r#"{"type":"deviceEvent","id":1,"id":1}"#);
        rig.session
            .handle_binary(&[9, 9, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    }
    assert_eq!(
        rig.wire.closed.lock().unwrap().as_ref().unwrap().0,
        DEVICE_PLANE_CLOSE_CODE
    );
    assert_eq!(
        rig.result(),
        "err:connectionLost",
        "the pending call settled"
    );
    assert!(!rig.session.device_enabled());
}

#[test]
fn closing_the_connection_settles_pending_work() {
    let mut rig = Rig::new();
    rig.connect(ALL);
    rig.dispatch("pick");
    rig.next("file.pick");
    rig.session.handle_close();
    assert_eq!(rig.result(), "err:connectionLost");
    assert!(!rig.session.device_enabled());
    rig.dispatch("pick");
    assert_eq!(rig.result(), "refused:unavailable:device-disabled");
}

#[test]
fn in_process_contexts_are_device_disabled() {
    let ctx = crate::context::GlobalContext::new();
    let d = ctx.device();
    assert!(!d.is_enabled() && !d.supports("file.pick"));
    assert_eq!(d.file_pick(&[], 1).unwrap_err(), DeviceError::disabled());
    let counter = AtomicUsize::new(0);
    ctx.with_device(Device::disabled(), || {
        counter.fetch_add(1, Ordering::SeqCst)
    });
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}
