//! Shared key-value storage backend for the native module hosts.
//!
//! One `KvBackend` sits behind every `hypen:storage` bucket a host serves
//! (both the sync v0.1 and async v0.2 hosts use this type). By default it
//! is purely in-memory — state survives instance teardown but not the
//! process. Pointing it at a file (`file_backed` / the hosts'
//! `set_storage_path`) makes `local`/`app` scopes write-through persistent:
//! every mutation rewrites the JSON snapshot atomically (tmp + rename), and
//! construction loads whatever a previous process left there.
//!
//! `cloud` is intentionally NOT persisted: the in-process compare-and-set
//! map is a dev-loop simulation of a sync service, and writing it to disk
//! would only make it pretend harder. When a real sync backend exists it
//! replaces the map, not the file format.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub(crate) struct CloudEntry {
    pub value: Vec<u8>,
    pub version: u64,
}

/// Snapshot format on disk. Only the plain (local/app) map; versioned so a
/// future layout change can migrate instead of discarding.
#[derive(Serialize, Deserialize, Default)]
struct PersistedKv {
    #[serde(default)]
    format: u32,
    #[serde(default)]
    plain: HashMap<String, Vec<u8>>,
}

const FORMAT: u32 = 1;

#[derive(Default)]
pub(crate) struct KvBackend {
    pub plain: HashMap<String, Vec<u8>>,
    pub cloud: HashMap<String, CloudEntry>,
    path: Option<PathBuf>,
}

impl KvBackend {
    /// Load (or start) a file-backed store. Missing file = empty store; a
    /// corrupt file is an error rather than a silent wipe.
    pub fn file_backed(path: PathBuf) -> io::Result<Self> {
        let plain = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<PersistedKv>(&bytes)
                .map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("corrupt storage file {}: {e}", path.display()),
                    )
                })?
                .plain,
            Err(e) if e.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e),
        };
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)?;
            }
        }
        Ok(Self {
            plain,
            cloud: HashMap::new(),
            path: Some(path),
        })
    }

    /// Write-through hook: call after any mutation of `plain`. No-op for
    /// in-memory stores. Failures are reported, not fatal — storage keeps
    /// serving from memory (dev-tool posture; a production host would
    /// surface this to the app).
    pub fn flush_plain(&self) {
        let Some(path) = &self.path else { return };
        let snapshot = PersistedKv {
            format: FORMAT,
            plain: self.plain.clone(),
        };
        let bytes = serde_json::to_vec(&snapshot).expect("kv snapshot serializes");
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, path)) {
            eprintln!("hypen: storage write-through failed ({}): {e}", path.display());
        }
    }
}
