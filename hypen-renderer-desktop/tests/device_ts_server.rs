//! The desktop client against a real device-enabled **TypeScript**
//! `RemoteServer` (bun, real WebSocket) — the setup of the tester report
//! "Desktop: device calls return device-disabled".
//!
//! Root cause, pinned by `ui_only_client_gets_device_disabled`: the desktop
//! `hello` carried no `device` advertisement, so every device-enabled server
//! disabled device access for the connection and each `context.device` call
//! answered `unavailable` / `device-disabled`. With the desktop DeviceHost
//! the same server negotiates the plane, and `file.pick`, `gallery.pick` and
//! `file.save` run end to end with hash verification on both sides, while
//! capabilities the desktop does not implement are `unsupported`.
//!
//! Needs `bun` and `hypen-web/node_modules`; skipped (with a message) when
//! either is missing, unless `HYPEN_E2E_REQUIRE=1` makes that a failure.

mod common;

use common::{scratch_dir, sha256_hex, write_file, FakeDialogs, Texts};
use hypen_renderer_desktop::device::DeviceConfig;
use hypen_renderer_desktop::module::HypenModule;
use hypen_renderer_desktop::remote::{RemoteModule, RemoteOptions};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "Bearer desktop-e2e";
const WAIT: Duration = Duration::from_secs(20);

struct Server {
    child: Child,
    url: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn start_server() -> Option<Server> {
    let required = std::env::var("HYPEN_E2E_REQUIRE").as_deref() == Ok("1");
    let skip = |why: &str| {
        if required {
            panic!("HYPEN_E2E_REQUIRE=1 but {why}");
        }
        eprintln!("SKIP device_ts_server: {why}");
        None
    };
    if !repo_root().join("hypen-web/node_modules").is_dir() {
        return skip("hypen-web/node_modules is missing (run `bun install` in hypen-web)");
    }
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/device-ts-server.ts");
    let mut child = match Command::new("bun")
        .arg("run")
        .arg(&script)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return skip(&format!("bun is not runnable: {e}")),
    };
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let port = loop {
        match lines.next() {
            Some(Ok(line)) => {
                if let Some(p) = line.strip_prefix("PORT=") {
                    break p.trim().to_string();
                }
            }
            _ => panic!("the TS server exited before listening"),
        }
    };
    // Keep draining stdout so the server never blocks on a full pipe.
    std::thread::spawn(move || for _ in lines {});
    Some(Server {
        child,
        url: format!("ws://127.0.0.1:{port}/ws"),
    })
}

fn connect(url: &str, device: Option<DeviceConfig>) -> (RemoteModule, Texts) {
    let module = RemoteModule::connect_with(
        url,
        "App",
        RemoteOptions::default()
            .header("Authorization", TOKEN)
            .device(device),
    );
    let texts = Texts::default();
    texts.attach(&module);
    module.mount();
    texts.wait_for("pick", "", WAIT); // the initial tree arrived
    (module, texts)
}

#[test]
fn ui_only_client_gets_device_disabled() {
    let Some(server) = start_server() else { return };
    // What the desktop sent before it had a device host: no hello.device.
    let (module, texts) = connect(&server.url, None);
    module.dispatch_action("supports", None);
    assert_eq!(
        texts.wait_for("supports", "-", WAIT),
        "file.pick=false,file.save=false,gallery.pick=false,camera.capture=false,mic.record=false"
    );
    module.dispatch_action("pick", None);
    assert_eq!(
        texts.wait_for("pick", "-", WAIT),
        "unavailable/device-disabled"
    );
}

#[test]
fn desktop_device_host_runs_file_pick_gallery_and_save_against_the_ts_server() {
    let Some(server) = start_server() else { return };
    let dir = scratch_dir("ts-e2e");
    // 150 KB + 3 bytes: more than one 64 KiB frame, not a multiple of it.
    let big: Vec<u8> = (0..150_003u32).map(|i| (i * 31 + 7) as u8).collect();
    let small = b"hello from the desktop".to_vec();
    let photo: Vec<u8> = (0..70_000u32).map(|i| (i ^ 0x5a) as u8).collect();
    let big_path = write_file(&dir, "big.bin", &big);
    let small_path = write_file(&dir, "notes.txt", &small);
    let photo_path = write_file(&dir, "cat.jpg", &photo);
    let dest = dir.join("saved-report.txt");

    let dialogs = Arc::new(FakeDialogs::default());
    let (module, texts) = connect(
        &server.url,
        Some(DeviceConfig::with_dialogs(dialogs.clone())),
    );

    module.dispatch_action("supports", None);
    assert_eq!(
        texts.wait_for("supports", "-", WAIT),
        "file.pick=true,file.save=true,gallery.pick=true,camera.capture=false,mic.record=false",
        "the server's live selection follows the desktop advertisement"
    );

    // file.pick: two files, streamed lazily, hash-verified by the server.
    *dialogs.picks.lock().unwrap() = Some(vec![big_path.clone(), small_path.clone()]);
    module.dispatch_action("pick", None);
    let expected = format!(
        "big.bin|application/octet-stream|{}|{};notes.txt|text/plain|{}|{}",
        big.len(),
        sha256_hex(&big),
        small.len(),
        sha256_hex(&small)
    );
    assert_eq!(texts.wait_for("pick", "-", WAIT), expected);
    let title = dialogs.pick_calls.lock().unwrap()[0].title.clone();
    assert!(
        title.starts_with("ws://127.0.0.1:"),
        "dialog names the origin: {title}"
    );

    // gallery.pick: a photo.
    *dialogs.picks.lock().unwrap() = Some(vec![photo_path]);
    module.dispatch_action("gallery", None);
    assert_eq!(
        texts.wait_for("gallery", "-", WAIT),
        format!("image/jpeg|{}|{}", photo.len(), sha256_hex(&photo))
    );

    // file.save: consent → destination → streamed download → verified,
    // committed atomically.
    *dialogs.save_to.lock().unwrap() = Some(dest.clone());
    module.dispatch_action("save", None);
    let saved = texts.wait_for("save", "-", WAIT);
    let written = std::fs::read(&dest).expect("destination written");
    assert_eq!(
        saved,
        format!("ok|{}|{}", written.len(), sha256_hex(&written))
    );
    assert!(written.len() > 128 * 1024);
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".part"))
        .collect();
    assert!(leftovers.is_empty(), "no temp file left: {leftovers:?}");

    // Not implemented on the desktop → unsupported, never device-disabled.
    module.dispatch_action("camera", None);
    assert!(
        texts
            .wait_for("camera", "-", WAIT)
            .starts_with("unsupported"),
        "camera.capture is unadvertised on the desktop"
    );

    // Dismissing the dialog is `cancelled`.
    *dialogs.picks.lock().unwrap() = None;
    module.dispatch_action("pick", None);
    assert_eq!(
        texts.wait_for("pick", &expected, WAIT),
        "cancelled/dismissed"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
