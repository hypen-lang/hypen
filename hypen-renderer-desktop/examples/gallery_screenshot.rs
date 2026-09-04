//! Component-gallery screenshot client for the native Desktop renderer.
//!
//! The gallery server streams its lightweight `initialTree`/`patch` envelope
//! immediately after WebSocket upgrade (rather than the production
//! `RemoteServer` Hello handshake), so this example provides the tiny adapter
//! needed to feed those patches into `DesktopApp`.

use futures_util::StreamExt;
use hypen_renderer_desktop::{DesktopApp, HypenModule, Patch};
use serde_json::Value;
use std::sync::{Arc, Mutex};

type PatchCallback = Arc<dyn Fn(&[Patch]) + Send + Sync>;

#[derive(Default)]
struct GalleryInner {
    callback: Option<PatchCallback>,
    pending: Vec<Patch>,
}

struct GalleryModule {
    inner: Arc<Mutex<GalleryInner>>,
}

impl GalleryModule {
    fn connect(url: String) -> Self {
        let inner = Arc::new(Mutex::new(GalleryInner::default()));
        let worker_inner = Arc::clone(&inner);
        std::thread::Builder::new()
            .name("hypen-gallery-screenshot".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("gallery screenshot runtime");
                runtime.block_on(async move {
                    let (socket, _) = tokio_tungstenite::connect_async(&url)
                        .await
                        .unwrap_or_else(|error| panic!("connect {url}: {error}"));
                    let (_, mut incoming) = socket.split();
                    while let Some(message) = incoming.next().await {
                        let message = match message {
                            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => text,
                            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                            Ok(_) => continue,
                            Err(error) => panic!("gallery WebSocket failed: {error}"),
                        };
                        let envelope: Value = serde_json::from_str(&message)
                            .unwrap_or_else(|error| panic!("decode gallery message: {error}"));
                        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or("");
                        if kind != "initialTree" && kind != "patch" {
                            continue;
                        }
                        let patches: Vec<Patch> = serde_json::from_value(
                            envelope
                                .get("patches")
                                .cloned()
                                .unwrap_or(Value::Array(vec![])),
                        )
                        .unwrap_or_else(|error| panic!("decode gallery patches: {error}"));
                        if patches.is_empty() {
                            continue;
                        }
                        let callback = {
                            let mut guard = worker_inner.lock().expect("gallery inner poisoned");
                            if let Some(callback) = guard.callback.as_ref() {
                                Some(Arc::clone(callback))
                            } else {
                                guard.pending.extend_from_slice(&patches);
                                None
                            }
                        };
                        if let Some(callback) = callback {
                            callback(&patches);
                        }
                    }
                });
            })
            .expect("spawn gallery screenshot worker");
        Self { inner }
    }
}

impl HypenModule for GalleryModule {
    fn on_patches(&self, callback: PatchCallback) {
        let pending = {
            let mut guard = self.inner.lock().expect("gallery inner poisoned");
            guard.callback = Some(Arc::clone(&callback));
            std::mem::take(&mut guard.pending)
        };
        if !pending.is_empty() {
            callback(&pending);
        }
    }

    fn mount(&self) {}

    fn dispatch_action(&self, _name: &str, _payload: Option<Value>) {
        // Component screenshots are non-interactive. Action transport is
        // deliberately omitted rather than pretending this is RemoteServer.
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = std::env::args().skip(1);
    let url = args
        .next()
        .expect("usage: gallery_screenshot <ws-url> <output.png>");
    let output = args
        .next()
        .expect("usage: gallery_screenshot <ws-url> <output.png>");
    let module: Arc<dyn HypenModule> = Arc::new(GalleryModule::connect(url));

    DesktopApp::new()
        .title("Hypen Desktop Component Gallery")
        .size(430, 934)
        .reduced_motion(true)
        .screenshot(output)
        .module(module)
        .run();
}
