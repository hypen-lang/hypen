//! The desktop client against a real **Rust SDK** server (`hypen-server`
//! `RemoteSession` with its device plane) over a real WebSocket, both in
//! this process — the fix for both tester reports end to end:
//!
//! - "Desktop: device calls return device-disabled": the desktop now
//!   advertises its DeviceHost, so `file.pick`, `gallery.pick` and
//!   `file.save` work; what it does not implement is `unsupported`.
//! - "Rust SDK: device communication is absent": the Rust server — whose
//!   sessions have the device plane on by default, built with
//!   `RemoteSession::connect` and no enable call — admits the native client
//!   by its authenticator (the app's connection admission, 403 without
//!   credentials), negotiates through the shared Rust selection, and hands
//!   handlers verified results through `ctx.device()`.
//!
//! A second server in this file is deliberately hostile: it interleaves
//! malformed, unknown and invalid device messages and frames with UI patches
//! and checks that the desktop keeps rendering, answers every attributable
//! violation per RFC 001 §2.1 and keeps dispatching actions.

mod common;

use common::{scratch_dir, sha256_hex, write_file, FakeDialogs, Texts};
use futures_util::{SinkExt, StreamExt};
use hypen_renderer_desktop::device::DeviceConfig;
use hypen_renderer_desktop::module::HypenModule;
use hypen_renderer_desktop::remote::{RemoteModule, RemoteOptions};
use hypen_server::device::{
    Admission, DeviceServer, DeviceServerConfig, DeviceTransport, SessionTransport, UpgradeRequest,
};
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "Bearer rust-e2e";
const WAIT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// The Rust SDK server
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct AppState {
    supports: String,
    pick: String,
    gallery: String,
    save: String,
    camera: String,
    ping: u32,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            supports: "-".into(),
            pick: "-".into(),
            gallery: "-".into(),
            save: "-".into(),
            camera: "-".into(),
            ping: 0,
        }
    }
}

fn save_bytes() -> Vec<u8> {
    "hypen rust save ".repeat(12_000).into_bytes() // 192 KB: several frames
}

fn app_module() -> Arc<ModuleDefinition<AppState>> {
    Arc::new(
        ModuleBuilder::<AppState>::new("App")
            .state(AppState::default())
            .ui(r#"Column {
                    Text("supports:@{state.supports}")
                    Text("pick:@{state.pick}")
                    Text("gallery:@{state.gallery}")
                    Text("save:@{state.save}")
                    Text("camera:@{state.camera}")
                    Text("ping:@{state.ping}")
                }"#)
            .on_action::<()>("supports", |s, _, ctx| {
                let d = ctx.unwrap().device();
                s.supports = [
                    "file.pick",
                    "file.save",
                    "gallery.pick",
                    "camera.capture",
                    "mic.record",
                ]
                .iter()
                .map(|c| format!("{c}={}", d.supports(c)))
                .collect::<Vec<_>>()
                .join(",");
            })
            .on_action::<()>("pick", |s, _, ctx| {
                match ctx.unwrap().device().file_pick(&[], 2) {
                    Ok(call) => call.then(|s: &mut AppState, r| {
                        s.pick = match r {
                            Ok(items) => items
                                .iter()
                                .map(|b| {
                                    format!(
                                        "{}|{}|{}|{}",
                                        b.name.clone().unwrap_or_default(),
                                        b.content_type,
                                        b.bytes.len(),
                                        sha256_hex(&b.bytes)
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(";"),
                            Err(e) => format!("{}/{}", e.code_str(), e.detail.unwrap_or_default()),
                        }
                    }),
                    Err(e) => s.pick = format!("{}/{}", e.code_str(), e.detail.unwrap_or_default()),
                }
            })
            .on_action::<()>("gallery", |s, _, ctx| {
                match ctx
                    .unwrap()
                    .device()
                    .gallery_pick(&[hypen_server::device::MediaType::Photo], 1)
                {
                    Ok(call) => call.then(|s: &mut AppState, r| {
                        s.gallery = match r {
                            Ok(items) => format!(
                                "{}|{}|{}",
                                items[0].content_type,
                                items[0].bytes.len(),
                                sha256_hex(&items[0].bytes)
                            ),
                            Err(e) => e.code_str().to_string(),
                        }
                    }),
                    Err(e) => s.gallery = e.code_str().to_string(),
                }
            })
            .on_action::<()>("save", |s, _, ctx| {
                match ctx
                    .unwrap()
                    .device()
                    .save("report.txt", "text/plain", save_bytes())
                {
                    Ok(call) => call.then(|s: &mut AppState, r| {
                        s.save = match r {
                            Ok(receipt) => format!(
                                "ok|{}|{}",
                                receipt.bytes_written,
                                sha256_hex(&save_bytes())
                            ),
                            Err(e) => e.code_str().to_string(),
                        }
                    }),
                    Err(e) => s.save = e.code_str().to_string(),
                }
            })
            .on_action::<()>("camera", |s, _, ctx| {
                let d = ctx.unwrap().device();
                s.camera = match d.camera_capture(hypen_server::device::CameraCaptureParams {
                    mode: hypen_server::device::CaptureMode::Photo,
                    facing: None,
                    max_duration_ms: None,
                }) {
                    Ok(call) => {
                        call.cancel();
                        "unexpectedly sent".into()
                    }
                    Err(e) => e.code_str().to_string(),
                };
            })
            .on_action::<()>("ping", |s, _, _| s.ping += 1)
            .build(),
    )
}

/// The socket writer queue: UI replies, device texts and frames share it,
/// in order (the device transport contract).
enum Out {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

struct ChannelTransport(mpsc::UnboundedSender<Out>);

impl DeviceTransport for ChannelTransport {
    fn send_text(&self, text: String) {
        let _ = self.0.send(Out::Text(text));
    }
    fn send_binary(&self, frame: Vec<u8>) {
        let _ = self.0.send(Out::Binary(frame));
    }
    fn close(&self, code: u16, reason: &str) {
        let _ = self.0.send(Out::Close(code, reason.to_string()));
    }
}

impl SessionTransport for ChannelTransport {
    fn send_ui(&self, message: String) {
        let _ = self.0.send(Out::Text(message));
    }
}

/// A Rust SDK server on an ephemeral port; returns its ws URL.
fn start_rust_server(rt: &tokio::runtime::Runtime) -> String {
    // Connection admission (the app's policy, not a device switch): a
    // browser Origin must be allow-listed, every upgrade must authenticate.
    let device_server = DeviceServer::new(
        DeviceServerConfig::default()
            .allow_origin("https://app.example")
            .authenticate(|r| r.header("authorization") == Some(TOKEN)),
    );
    let listener = rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    rt.spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let device_server = Arc::clone(&device_server);
            tokio::spawn(async move { serve(stream, device_server).await });
        }
    });
    format!("ws://127.0.0.1:{port}/ws")
}

async fn serve(stream: tokio::net::TcpStream, device_server: Arc<DeviceServer>) {
    // Admission runs on the HTTP upgrade (RFC 001 §5): 403 on refusal.
    let ds = Arc::clone(&device_server);
    // The Err type is tungstenite's handshake API, not ours.
    #[allow(clippy::result_large_err)]
    let callback =
        move |req: &Request, resp: Response| -> std::result::Result<Response, ErrorResponse> {
            let mut up = UpgradeRequest::new(req.uri().path());
            for (k, v) in req.headers() {
                up = up.with_header(k.as_str(), v.to_str().unwrap_or(""));
            }
            match ds.admit(&up) {
                Admission::Admitted => Ok(resp),
                Admission::Rejected { status, .. } => {
                    let mut r = ErrorResponse::new(Some("forbidden".into()));
                    *r.status_mut() =
                        tokio_tungstenite::tungstenite::http::StatusCode::from_u16(status).unwrap();
                    Err(r)
                }
            }
        };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    // The session for this connection: its transport at construction is
    // all the device plane needs (on by default, no enable call).
    let session = Arc::new(
        RemoteSession::connect(
            app_module(),
            ComponentRegistry::new(),
            Arc::new(ChannelTransport(tx.clone())),
        )
        .with_device_server(&device_server),
    );
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let r = match out {
                Out::Text(t) => sink.send(Message::Text(t)).await,
                Out::Binary(b) => sink.send(Message::Binary(b)).await,
                Out::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(
                            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: code.into(),
                                reason: reason.into(),
                            },
                        )))
                        .await;
                    break;
                }
            };
            if r.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = source.next().await {
        match msg {
            Message::Text(text) => {
                let tx = tx.clone();
                session.handle_message_with(&text, move |m| {
                    let _ = tx.send(Out::Text(m.to_string()));
                });
            }
            Message::Binary(frame) => session.handle_binary(&frame),
            Message::Close(_) => break,
            _ => {}
        }
    }
    session.handle_close();
    drop(tx);
    let _ = writer.await;
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

fn connect(url: &str, options: RemoteOptions) -> (RemoteModule, Texts) {
    let module = RemoteModule::connect_with(url, "App", options);
    let texts = Texts::default();
    texts.attach(&module);
    module.mount();
    texts.wait_for("ping", "", WAIT);
    (module, texts)
}

// ---------------------------------------------------------------------------
// Tests against the Rust SDK server
// ---------------------------------------------------------------------------

#[test]
fn rust_server_refuses_native_clients_without_credentials() {
    let rt = runtime();
    let url = start_rust_server(&rt);
    // The authenticator runs for every upgrade: no Authorization → 403.
    let err = rt
        .block_on(tokio_tungstenite::connect_async(url.as_str()))
        .map(|_| ())
        .expect_err("refused");
    assert!(err.to_string().contains("403"), "{err}");
    // A browser-style Origin that is not allowlisted is refused too, even
    // with credentials.
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        url.as_str(),
    )
    .unwrap();
    req.headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    req.headers_mut()
        .insert("Authorization", TOKEN.parse().unwrap());
    assert!(rt.block_on(tokio_tungstenite::connect_async(req)).is_err());
}

#[test]
fn desktop_and_rust_server_run_device_work_end_to_end() {
    let rt = runtime();
    let url = start_rust_server(&rt);
    let dir = scratch_dir("rust-e2e");
    let doc: Vec<u8> = (0..130_001u32).map(|i| (i * 7 + 3) as u8).collect();
    let note = b"a note".to_vec();
    let photo: Vec<u8> = (0..9_000u32).map(|i| (i % 13) as u8).collect();
    let doc_path = write_file(&dir, "doc.pdf", &doc);
    let note_path = write_file(&dir, "note.txt", &note);
    let photo_path = write_file(&dir, "pic.png", &photo);
    let dest = dir.join("saved.txt");

    let dialogs = Arc::new(FakeDialogs::default());
    let (module, texts) = connect(
        &url,
        RemoteOptions::default()
            .header("Authorization", TOKEN)
            .device(Some(DeviceConfig::with_dialogs(dialogs.clone()))),
    );

    module.dispatch_action("supports", None);
    assert_eq!(
        texts.wait_for("supports", "-", WAIT),
        "file.pick=true,file.save=true,gallery.pick=true,camera.capture=false,mic.record=false"
    );

    *dialogs.picks.lock().unwrap() = Some(vec![doc_path, note_path]);
    module.dispatch_action("pick", None);
    assert_eq!(
        texts.wait_for("pick", "-", WAIT),
        format!(
            "doc.pdf|application/pdf|{}|{};note.txt|text/plain|{}|{}",
            doc.len(),
            sha256_hex(&doc),
            note.len(),
            sha256_hex(&note)
        )
    );

    *dialogs.picks.lock().unwrap() = Some(vec![photo_path]);
    module.dispatch_action("gallery", None);
    assert_eq!(
        texts.wait_for("gallery", "-", WAIT),
        format!("image/png|{}|{}", photo.len(), sha256_hex(&photo))
    );

    *dialogs.save_to.lock().unwrap() = Some(dest.clone());
    module.dispatch_action("save", None);
    let bytes = save_bytes();
    assert_eq!(
        texts.wait_for("save", "-", WAIT),
        format!("ok|{}|{}", bytes.len(), sha256_hex(&bytes))
    );
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    assert!(dialogs.save_calls.lock().unwrap()[0]
        .title
        .contains("report.txt"));

    module.dispatch_action("camera", None);
    assert_eq!(texts.wait_for("camera", "-", WAIT), "unsupported");

    // The UI path is unaffected by all of it.
    module.dispatch_action("ping", None);
    assert_eq!(texts.wait_for("ping", "0", WAIT), "1");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_ui_only_desktop_gets_device_disabled_from_the_rust_server() {
    let rt = runtime();
    let url = start_rust_server(&rt);
    let (module, texts) = connect(
        &url,
        RemoteOptions::default()
            .header("Authorization", TOKEN)
            .device(None),
    );
    module.dispatch_action("pick", None);
    assert_eq!(
        texts.wait_for("pick", "-", WAIT),
        "unavailable/device-disabled"
    );
}

// ---------------------------------------------------------------------------
// A hostile server
// ---------------------------------------------------------------------------

fn frame(version: u8, flags: u8, id: u32, seq: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![version, flags, 0, 0];
    f.extend_from_slice(&id.to_le_bytes());
    f.extend_from_slice(&seq.to_le_bytes());
    f.extend_from_slice(payload);
    f
}

fn text_patch(id: &str, text: &str) -> Value {
    json!({"type":"create","id":id,"elementType":"Text","props":{"0":text}})
}

/// Serves one connection: a valid handshake selecting the desktop's
/// capabilities, then a barrage of malformed / unknown / invalid messages
/// interleaved with UI patches. Reports what the desktop sent back.
async fn hostile(listener: TcpListener, seen: Arc<Mutex<Vec<Value>>>) {
    let (stream, _) = listener.accept().await.unwrap();
    let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
    let (mut sink, mut source) = ws.split();
    let hello: Value = match source.next().await {
        Some(Ok(Message::Text(t))) => serde_json::from_str(&t).unwrap(),
        other => panic!("expected hello, got {other:?}"),
    };
    let offers = hello["device"]["capabilities"].as_array().cloned().unwrap();
    let selection: Vec<Value> = offers
        .iter()
        .map(|o| json!({"name": o["name"], "version": 1}))
        .collect();
    let send = |v: Value| Message::Text(v.to_string());
    let mut script: Vec<Message> = vec![
        send(
            json!({"type":"sessionAck","sessionId":"hostile","isNew":true,"isRestored":false,
                    "device":{"protocolVersion":1,"binary":true,"capabilities":selection}}),
        ),
        send(
            json!({"type":"initialTree","module":"App","state":{},"revision":0,
                    "patches":[text_patch("t0", "step:0")]}),
        ),
        send(
            json!({"type":"deviceRequest","id":1,"capability":"core.capabilities","version":1,
                    "owner":{"connection":true},"lifetime":"connection","timeoutMs":86_400_000,
                    "initialCredit":8,"params":{}}),
        ),
        // Garbage device text: connection-level, counted, ignored.
        Message::Text(r#"{"type":"deviceEvent","id":1,"id":1,"control":{"renewLease":1}}"#.into()),
        Message::Text(r#"{"type":"deviceRequest","id":2.0}"#.into()),
        Message::Text(
            "{\"type\":\"deviceEvent\",\"pad\":\"".to_string() + &"x".repeat(1_100_000) + "\"}",
        ),
        // Bad frame headers (unknown version, flags), a short frame, a frame
        // for an unknown id: all without effect.
        Message::Binary(frame(7, 0, 1, 0, b"x")),
        Message::Binary(frame(1, 3, 1, 0, b"x")),
        Message::Binary(vec![1, 0, 0]),
        Message::Binary(frame(1, 0, 999, 0, b"x")),
        // Not JSON, no type, an unknown type, a UI message with a bad field.
        Message::Text("this is not json".into()),
        Message::Text(r#"{"hello":"world"}"#.into()),
        Message::Text(r#"{"type":"fromTheFuture","x":1}"#.into()),
        Message::Text(r#"{"type":"sessionExpired","sessionId":7}"#.into()),
        // A patch batch with one malformed and one unknown patch between
        // two good ones: the good ones apply.
        send(
            json!({"type":"patch","module":"App","revision":1,"patches":[
            text_patch("t1", "step:1"),
            {"type":"create","id":42},
            {"type":"teleport","id":"t0"},
            {"type":"setProp","id":"t0","name":"0","value":"step:2"}]}),
        ),
        // Attributable violations: a request the desktop never offered
        // (unsupported), a request with bad params (invalidParams), then a
        // live request broken by a server deviceResponse (invalidParams).
        send(
            json!({"type":"deviceRequest","id":3,"capability":"mic.record","version":1,
                    "owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation",
                    "timeoutMs":1000,"initialCredit":1024,"params":{"format":"pcm16","sampleRate":8000}}),
        ),
        send(
            json!({"type":"deviceRequest","id":4,"capability":"file.pick","version":1,
                    "owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation",
                    "timeoutMs":1000,"initialCredit":1024,"params":{"accept":[],"maxCount":0}}),
        ),
        send(
            json!({"type":"deviceRequest","id":5,"capability":"file.save","version":1,
                    "owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation",
                    "timeoutMs":60_000,"initialCredit":0,"params":{"channel":0,"name":"x.txt",
                    "contentType":"text/plain","bytes":3,"sha256":sha256_hex(b"abc")}}),
        ),
        send(json!({"type":"deviceResponse","id":5,"result":{}})),
        // More UI after all of it.
        send(
            json!({"type":"patch","module":"App","revision":2,"patches":[
            {"type":"setProp","id":"t1","name":"0","value":"step:3"}]}),
        ),
    ];
    for m in script.drain(..) {
        sink.send(m).await.unwrap();
    }
    // Collect what the desktop answers until it dispatches "done".
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let next = tokio::time::timeout_at(deadline, source.next()).await;
        match next {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                let done = v["type"] == "dispatchAction" && v["action"] == "done";
                seen.lock().unwrap().push(v);
                if done {
                    // Prove the connection still carries UI both ways.
                    sink.send(send(
                        json!({"type":"patch","module":"App","revision":3,"patches":[
                        {"type":"setProp","id":"t1","name":"0","value":"step:done"}]}),
                    ))
                    .await
                    .unwrap();
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return,
        }
    }
}

#[test]
fn hostile_device_traffic_never_stops_ui_patches() {
    let rt = runtime();
    let listener = rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    rt.spawn(hostile(listener, Arc::clone(&seen)));

    let module = RemoteModule::connect_with(
        &url,
        "App",
        RemoteOptions::default().device(Some(DeviceConfig::with_dialogs(Arc::new(
            FakeDialogs::default(),
        )))),
    );
    let texts = Texts::default();
    texts.attach(&module);
    module.mount();
    let wait_both = |a: &str, b: &str| {
        let start = std::time::Instant::now();
        loop {
            let t0 = texts.node("t0");
            let t1 = texts.node("t1");
            if t0.as_deref() == Some(a) && t1.as_deref() == Some(b) {
                return;
            }
            assert!(start.elapsed() < WAIT, "t0={t0:?} t1={t1:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait_both("step:2", "step:3");

    // The connection still works both ways.
    module.dispatch_action("done", None);
    wait_both("step:2", "step:done");

    let seen = seen.lock().unwrap().clone();
    let response = |id: u64| {
        seen.iter()
            .find(|m| m["type"] == "deviceResponse" && m["id"] == id)
            .map(|m| m["error"]["code"].clone())
    };
    assert_eq!(response(3), Some(json!("unsupported")), "{seen:?}");
    assert_eq!(response(4), Some(json!("invalidParams")));
    assert_eq!(response(5), Some(json!("invalidParams")));
    assert_eq!(
        response(2),
        None,
        "a malformed id is attributable to nothing"
    );
    // The core stream is live and got the desktop's full advertisement.
    let snapshot = seen
        .iter()
        .find(|m| m["id"] == 1 && m["event"]["capabilities"].is_array())
        .expect("core snapshot");
    let names: Vec<&str> = snapshot["event"]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "core.capabilities",
            "file.pick",
            "gallery.pick",
            "file.save"
        ]
    );
    assert!(
        !seen
            .iter()
            .any(|m| m["id"] == 1 && m["type"] == "deviceResponse"),
        "garbage never terminated the core stream"
    );
}
