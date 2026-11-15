//! Shared key-value storage backend for the native module hosts.
//!
//! One `KvBackend` sits behind every `hypen:storage` bucket a host serves
//! (both the v0.1 and v0.2 hosts use this type).
//!
//! ## Isolation
//!
//! Entries live in **partitions** keyed by `(scope, owner)`:
//!
//! - `local` — owner is the *registered module name*, which the host binds
//!   when it creates the instance. A module never names its own partition,
//!   so it cannot read or overwrite another module's `local` data (the
//!   "host transparently prefixes every key with the module name" rule in
//!   `hypen:storage`).
//! - `app` — one partition for the whole app, shared by every module holding
//!   the `app` grant (a deliberate coordination surface per the WIT).
//! - `cloud` — one user-scoped partition, shared by every module holding the
//!   `cloud` grant.
//!
//! Inside a partition the entry key encodes `(tier, namespace, key)` with a
//! length-prefixed namespace, so guest-chosen strings can never alias each
//! other (`("a/b", "c")` and `("a", "b/c")` are distinct).
//!
//! ## Quotas
//!
//! Every write is checked against a per-value cap and a per-partition byte
//! budget ([`KvQuota`], from `ModuleLimits`); a write over either returns
//! the number of bytes over budget, which the hosts surface as the WIT's
//! `quota-exceeded`.
//!
//! ## Persistence
//!
//! By default the store is purely in-memory — state survives instance
//! teardown but not the process. Pointing it at a file (`file_backed` / the
//! hosts' `set_storage_path`) makes the `local`/`app` scopes persistent:
//! mutations mark the store dirty and the hosts call [`KvBackend::flush`]
//! once at the end of each guest call (and the store flushes on drop), so a
//! reducer doing N writes costs one snapshot rewrite, not N. The snapshot is
//! written atomically (tmp + rename).
//!
//! `cloud` is intentionally NOT persisted: the in-process compare-and-set
//! map is a dev-loop simulation of a sync service, and writing it to disk
//! would only make it pretend harder. When a real sync backend exists it
//! replaces the map, not the file format.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::PathBuf;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// Storage visibility scope of a partition.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KvScope {
    Local,
    App,
    Cloud,
}

/// Identifies the partition a bucket reads and writes: the scope plus, for
/// `local`, the owning module. Built by the host from the *registered* module
/// name — never from guest input.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) struct PartitionId {
    scope: KvScope,
    owner: String,
}

impl PartitionId {
    pub fn new(scope: KvScope, module: &str) -> Self {
        let owner = match scope {
            KvScope::Local => module.to_string(),
            // Shared scopes have a single partition; access is gated by the
            // manifest grant at link time.
            KvScope::App | KvScope::Cloud => String::new(),
        };
        Self { scope, owner }
    }

    pub fn scope(&self) -> KvScope {
        self.scope
    }
}

/// Encode `(tier, namespace, key)` into one unambiguous entry key. `tier` is
/// a fixed host-chosen token; the namespace is length-prefixed (bytes), so no
/// choice of namespace/key can collide with a different pair.
pub(crate) fn entry_key(tier: &str, namespace: &str, key: &str) -> String {
    format!("{tier}/{}:{namespace}{key}", namespace.len())
}

/// Write limits applied to every `set` / `compare-and-set`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct KvQuota {
    /// Largest single value, in bytes.
    pub max_value_bytes: u64,
    /// Budget for one partition (entry keys + values), in bytes.
    pub max_partition_bytes: u64,
}

/// Why a write was refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum KvWriteError {
    /// Over quota by this many bytes (the WIT `quota-exceeded` payload).
    QuotaExceeded(u64),
    /// `compare-and-set` saw a different version than expected.
    VersionMismatch,
}

pub(crate) struct Entry {
    pub value: Vec<u8>,
    /// Bumped on every successful write. Only surfaced to guests on `cloud`.
    pub version: u64,
}

#[derive(Default)]
struct Partition {
    /// Sum of `entry_key.len() + value.len()` over `entries`.
    bytes: u64,
    entries: HashMap<String, Entry>,
}

fn cost(entry_key: &str, value: &[u8]) -> u64 {
    entry_key.len() as u64 + value.len() as u64
}

/// Snapshot format on disk: the persistent (`local`/`app`) partitions, values
/// base64-encoded. Versioned so a layout change is detected rather than
/// misread.
#[derive(Serialize, Deserialize)]
struct PersistedKv {
    format: u32,
    partitions: Vec<PersistedPartition>,
}

#[derive(Serialize, Deserialize)]
struct PersistedPartition {
    scope: KvScope,
    owner: String,
    entries: BTreeMap<String, String>,
}

const FORMAT: u32 = 2;

#[derive(Default)]
pub(crate) struct KvBackend {
    partitions: HashMap<PartitionId, Partition>,
    path: Option<PathBuf>,
    /// A persistent partition changed since the last successful flush.
    dirty: bool,
}

fn invalid(path: &std::path::Path, why: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("unreadable storage file {}: {why}", path.display()),
    )
}

impl KvBackend {
    /// Load (or start) a file-backed store. Missing file = empty store; a
    /// corrupt file or one in another format version is an error rather than
    /// a silent wipe (the file is left untouched).
    pub fn file_backed(path: PathBuf) -> io::Result<Self> {
        let mut partitions = HashMap::new();
        match std::fs::read(&path) {
            Ok(bytes) => {
                let raw: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|e| invalid(&path, e))?;
                let format = raw.get("format").and_then(|f| f.as_u64());
                if format != Some(FORMAT as u64) {
                    return Err(invalid(
                        &path,
                        format!(
                            "storage format {} is not supported (this host reads format {FORMAT}); \
                             move the file aside or delete it to start with empty storage",
                            format.map_or("<missing>".to_string(), |f| f.to_string()),
                        ),
                    ));
                }
                let persisted: PersistedKv =
                    serde_json::from_value(raw).map_err(|e| invalid(&path, e))?;
                for p in persisted.partitions {
                    if p.scope == KvScope::Cloud {
                        return Err(invalid(&path, "cloud scope is never persisted"));
                    }
                    let mut part = Partition::default();
                    for (k, encoded) in p.entries {
                        let value = base64::engine::general_purpose::STANDARD
                            .decode(&encoded)
                            .map_err(|e| invalid(&path, format!("entry `{k}`: {e}")))?;
                        part.bytes += cost(&k, &value);
                        part.entries.insert(k, Entry { value, version: 1 });
                    }
                    let id = PartitionId { scope: p.scope, owner: p.owner };
                    if partitions.insert(id, part).is_some() {
                        return Err(invalid(&path, "duplicate partition"));
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)?;
            }
        }
        Ok(Self {
            partitions,
            path: Some(path),
            dirty: false,
        })
    }

    pub fn get(&self, part: &PartitionId, entry_key: &str) -> Option<&Entry> {
        self.partitions.get(part)?.entries.get(entry_key)
    }

    /// Unconditional write. Returns the entry's new version.
    pub fn set(
        &mut self,
        part: &PartitionId,
        entry_key: String,
        value: Vec<u8>,
        quota: KvQuota,
    ) -> Result<u64, KvWriteError> {
        self.write(part, entry_key, value, quota, None)
    }

    /// Versioned write: succeeds only if the entry's current version equals
    /// `expected` (`None` = the entry must not exist). Returns the new version.
    pub fn compare_and_set(
        &mut self,
        part: &PartitionId,
        entry_key: String,
        expected: Option<u64>,
        value: Vec<u8>,
        quota: KvQuota,
    ) -> Result<u64, KvWriteError> {
        self.write(part, entry_key, value, quota, Some(expected))
    }

    fn write(
        &mut self,
        part: &PartitionId,
        entry_key: String,
        value: Vec<u8>,
        quota: KvQuota,
        expected: Option<Option<u64>>,
    ) -> Result<u64, KvWriteError> {
        let existing = self.partitions.get(part);
        let current = existing.and_then(|p| p.entries.get(&entry_key));
        let current_version = current.map(|e| e.version);
        if let Some(expected) = expected {
            if expected != current_version {
                return Err(KvWriteError::VersionMismatch);
            }
        }
        let value_len = value.len() as u64;
        if value_len > quota.max_value_bytes {
            return Err(KvWriteError::QuotaExceeded(value_len - quota.max_value_bytes));
        }
        let old_cost = current.map_or(0, |e| cost(&entry_key, &e.value));
        let new_cost = cost(&entry_key, &value);
        let used = existing.map_or(0, |p| p.bytes);
        let next_used = used - old_cost + new_cost;
        // Shrinking (or same-size) rewrites are always allowed so a module
        // can reduce its footprint even if the budget was lowered under it.
        if next_used > quota.max_partition_bytes && new_cost > old_cost {
            return Err(KvWriteError::QuotaExceeded(next_used - quota.max_partition_bytes));
        }

        let version = current_version.unwrap_or(0) + 1;
        let partition = self.partitions.entry(part.clone()).or_default();
        partition.bytes = next_used;
        partition.entries.insert(entry_key, Entry { value, version });
        self.mark_dirty(part);
        Ok(version)
    }

    /// Remove an entry. Returns whether it existed.
    pub fn delete(&mut self, part: &PartitionId, entry_key: &str) -> bool {
        let Some(partition) = self.partitions.get_mut(part) else {
            return false;
        };
        let Some(old) = partition.entries.remove(entry_key) else {
            return false;
        };
        partition.bytes -= cost(entry_key, &old.value);
        if partition.entries.is_empty() {
            self.partitions.remove(part);
        }
        self.mark_dirty(part);
        true
    }

    fn mark_dirty(&mut self, part: &PartitionId) {
        if part.scope != KvScope::Cloud && self.path.is_some() {
            self.dirty = true;
        }
    }

    /// Persist pending changes, if any. The hosts call this once at the end
    /// of every guest call. No-op for in-memory stores and when nothing
    /// changed. Failures are reported, not fatal — storage keeps serving
    /// from memory and the next flush retries (dev-tool posture; a
    /// production host would surface this to the app).
    pub fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(path) = &self.path else { return };

        let mut ids: Vec<&PartitionId> = self
            .partitions
            .keys()
            .filter(|id| id.scope != KvScope::Cloud)
            .collect();
        ids.sort();
        let snapshot = PersistedKv {
            format: FORMAT,
            partitions: ids
                .into_iter()
                .map(|id| PersistedPartition {
                    scope: id.scope,
                    owner: id.owner.clone(),
                    entries: self.partitions[id]
                        .entries
                        .iter()
                        .map(|(k, e)| {
                            (
                                k.clone(),
                                base64::engine::general_purpose::STANDARD.encode(&e.value),
                            )
                        })
                        .collect(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&snapshot).expect("kv snapshot serializes");
        let tmp = path.with_extension("json.tmp");
        match std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, path)) {
            Ok(()) => self.dirty = false,
            Err(e) => eprintln!("hypen: storage flush failed ({}): {e}", path.display()),
        }
    }
}

impl Drop for KvBackend {
    fn drop(&mut self) {
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTA: KvQuota = KvQuota { max_value_bytes: 64, max_partition_bytes: 200 };

    fn local(module: &str) -> PartitionId {
        PartitionId::new(KvScope::Local, module)
    }

    #[test]
    fn entry_keys_do_not_alias_across_namespace_and_key() {
        assert_ne!(entry_key("persistent", "a/b", "c"), entry_key("persistent", "a", "b/c"));
        assert_ne!(entry_key("persistent", "a", "1:b"), entry_key("persistent", "a1:", "b"));
        assert_ne!(entry_key("persistent", "", "x"), entry_key("cache", "", "x"));
    }

    #[test]
    fn local_partitions_are_per_module_and_shared_scopes_are_not() {
        assert_ne!(local("a"), local("b"));
        assert_eq!(PartitionId::new(KvScope::App, "a"), PartitionId::new(KvScope::App, "b"));
        assert_eq!(PartitionId::new(KvScope::Cloud, "a"), PartitionId::new(KvScope::Cloud, "b"));
        // A module named like a shared scope's (empty) owner still can't
        // reach it: the scope is part of the id.
        assert_ne!(local(""), PartitionId::new(KvScope::App, ""));
    }

    #[test]
    fn quota_rejects_oversized_values_and_full_partitions() {
        let mut kv = KvBackend::default();
        let p = local("m");
        assert_eq!(
            kv.set(&p, "k".into(), vec![0; 65], QUOTA),
            Err(KvWriteError::QuotaExceeded(1))
        );
        // 3 × (2 + 64) = 198 bytes fit; the fourth entry is 64 over.
        for i in 0..3 {
            kv.set(&p, format!("k{i}"), vec![0; 64], QUOTA).unwrap();
        }
        assert_eq!(
            kv.set(&p, "k3".into(), vec![0; 64], QUOTA),
            Err(KvWriteError::QuotaExceeded(64))
        );
        // Another module's budget is independent.
        kv.set(&local("other"), "k3".into(), vec![0; 64], QUOTA).unwrap();
        // Overwriting in place and deleting free budget.
        kv.set(&p, "k0".into(), vec![0; 1], QUOTA).unwrap();
        kv.set(&p, "k3".into(), vec![0; 60], QUOTA).unwrap();
        assert!(kv.delete(&p, "k1"));
        assert!(!kv.delete(&p, "k1"));
    }

    #[test]
    fn compare_and_set_checks_the_version() {
        let mut kv = KvBackend::default();
        let p = PartitionId::new(KvScope::Cloud, "m");
        assert_eq!(kv.compare_and_set(&p, "k".into(), None, vec![1], QUOTA), Ok(1));
        assert_eq!(
            kv.compare_and_set(&p, "k".into(), None, vec![2], QUOTA),
            Err(KvWriteError::VersionMismatch)
        );
        assert_eq!(kv.compare_and_set(&p, "k".into(), Some(1), vec![2], QUOTA), Ok(2));
        assert_eq!(kv.set(&p, "k".into(), vec![3], QUOTA), Ok(3));
    }

    #[test]
    fn flushes_once_when_asked_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kv.json");
        {
            let mut kv = KvBackend::file_backed(path.clone()).unwrap();
            kv.set(&local("m"), entry_key("persistent", "ns", "k"), vec![0, 255, 7], QUOTA)
                .unwrap();
            kv.set(&PartitionId::new(KvScope::Cloud, "m"), "c".into(), vec![1], QUOTA)
                .unwrap();
            // Writes only mark the store dirty; nothing hits disk until flush.
            assert!(!path.exists());
            kv.flush();
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(text.contains("\"AP8H\""), "values are base64: {text}");
            assert!(!text.contains("cloud"), "cloud is not persisted: {text}");
            // Dropping flushes whatever is still pending.
            kv.set(&local("m"), "late".into(), vec![9], QUOTA).unwrap();
        }
        let kv = KvBackend::file_backed(path).unwrap();
        assert_eq!(
            kv.get(&local("m"), &entry_key("persistent", "ns", "k")).unwrap().value,
            vec![0, 255, 7]
        );
        assert_eq!(kv.get(&local("m"), "late").unwrap().value, vec![9]);
        assert!(kv.get(&local("other"), "late").is_none());
    }

    #[test]
    fn old_or_corrupt_files_are_errors_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("v1.json", r#"{"format":1,"plain":{"Local/Persistent/ns/k":[1,2]}}"#),
            ("noformat.json", r#"{"plain":{}}"#),
            ("garbage.json", "not json"),
            ("badvalue.json", r#"{"format":2,"partitions":[{"scope":"local","owner":"m","entries":{"k":"***"}}]}"#),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            let err = match KvBackend::file_backed(path.clone()) {
                Ok(_) => panic!("{name} should not load"),
                Err(e) => e,
            };
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{name}");
            assert!(err.to_string().contains(name), "{name}: {err}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body, "{name} untouched");
        }
    }
}
