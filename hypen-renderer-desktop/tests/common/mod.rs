//! Shared helpers for the desktop client's device integration tests.
#![allow(dead_code)]

use hypen_engine::Patch;
use hypen_renderer_desktop::device::{DialogUnavailable, FileDialogs, PickDialog, SaveDialog};
use hypen_renderer_desktop::module::HypenModule;
use hypen_renderer_desktop::remote::RemoteModule;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Scripted dialogs: every pick returns `picks`, every save `save_to`;
/// each call is recorded (the title proves the host names the origin).
#[derive(Default)]
pub struct FakeDialogs {
    pub picks: Mutex<Option<Vec<PathBuf>>>,
    pub save_to: Mutex<Option<PathBuf>>,
    pub pick_calls: Mutex<Vec<PickDialog>>,
    pub save_calls: Mutex<Vec<SaveDialog>>,
    pub unavailable: bool,
}

impl FileDialogs for FakeDialogs {
    fn available(&self) -> bool {
        !self.unavailable
    }
    fn pick_files(&self, r: &PickDialog) -> Result<Option<Vec<PathBuf>>, DialogUnavailable> {
        self.pick_calls.lock().unwrap().push(r.clone());
        Ok(self.picks.lock().unwrap().clone())
    }
    fn save_file(&self, r: &SaveDialog) -> Result<Option<PathBuf>, DialogUnavailable> {
        self.save_calls.lock().unwrap().push(r.clone());
        Ok(self.save_to.lock().unwrap().clone())
    }
}

/// A fresh scratch directory under the system temp dir.
pub fn scratch_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "hypen-desktop-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

/// The rendered `Text` strings of a patch stream (prop `"0"` by node id).
#[derive(Clone, Default)]
pub struct Texts(Arc<Mutex<HashMap<String, String>>>);

impl Texts {
    pub fn attach(&self, module: &RemoteModule) {
        let texts = Arc::clone(&self.0);
        module.on_patches(Arc::new(move |patches: &[Patch]| {
            let mut t = texts.lock().unwrap();
            for p in patches {
                match p {
                    Patch::Create { id, props, .. } => {
                        if let Some(s) = props.get("0").and_then(|v| v.as_str()) {
                            t.insert(id.to_string(), s.to_string());
                        }
                    }
                    Patch::SetProp { id, name, value } if name == "0" => {
                        if let Some(s) = value.as_str() {
                            t.insert(id.to_string(), s.to_string());
                        }
                    }
                    Patch::Remove { id, .. } => {
                        t.remove(id.as_ref());
                    }
                    _ => {}
                }
            }
        }));
    }

    /// The value rendered as `key:<value>`.
    pub fn get(&self, key: &str) -> Option<String> {
        let prefix = format!("{key}:");
        self.0
            .lock()
            .unwrap()
            .values()
            .find_map(|s| s.strip_prefix(&prefix).map(str::to_string))
    }

    /// The text rendered by node `id`.
    pub fn node(&self, id: &str) -> Option<String> {
        self.0.lock().unwrap().get(id).cloned()
    }

    /// Wait until `key` renders something other than `unset`.
    pub fn wait_for(&self, key: &str, unset: &str, timeout: Duration) -> String {
        let start = Instant::now();
        loop {
            if let Some(v) = self.get(key) {
                if v != unset {
                    return v;
                }
            }
            if start.elapsed() > timeout {
                panic!(
                    "timed out waiting for {key}; texts = {:?}",
                    self.0.lock().unwrap().values().collect::<Vec<_>>()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
