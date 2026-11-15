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
//! A failed flush is returned to the caller ([`FlushError`], naming the file);
//! the store keeps serving from memory, stays dirty, and the next flush
//! retries.
//!
//! `cloud` is intentionally NOT persisted: the in-process compare-and-set
//! map is a dev-loop simulation of a sync service, and writing it to disk
//! would only make it pretend harder. When a real sync backend exists it
//! replaces the map, not the file format.

use std::borrow::Borrow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io;
use std::ops::Bound;
use std::path::PathBuf;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::StorageScope;

/// The name a module was *registered* under. It keys the module's `local`
/// storage partition and is what manifests name in `reads` / `dispatches`.
/// Always host-chosen: a guest never supplies its own `ModuleName`.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) struct ModuleName(String);

impl ModuleName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModuleName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// Lets `HashSet<ModuleName>` / `HashMap<ModuleName, _>` be probed with the
// `&str` a guest passed, without allocating.
impl Borrow<str> for ModuleName {
    fn borrow(&self) -> &str {
        &self.0
    }
}

/// Identifies the partition a bucket reads and writes: the scope plus, for
/// `local`, the owning module. Built by the host from the *registered* module
/// name — never from guest input.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) struct PartitionId {
    scope: StorageScope,
    /// `Some` for `local` only: shared scopes have a single partition.
    owner: Option<ModuleName>,
}

impl PartitionId {
    pub fn new(scope: StorageScope, module: &ModuleName) -> Self {
        let owner = match scope {
            StorageScope::Local => Some(module.clone()),
            // Shared scopes have a single partition; access is gated by the
            // manifest grant at link time.
            StorageScope::App | StorageScope::Cloud => None,
        };
        Self { scope, owner }
    }

    pub fn scope(&self) -> StorageScope {
        self.scope
    }

    /// `cloud` simulates a sync service and never reaches the snapshot file.
    fn is_persistent(&self) -> bool {
        self.scope != StorageScope::Cloud
    }
}

/// The part of an entry key that identifies one bucket inside a partition:
/// `(tier, namespace)`. `tier` is a fixed host-chosen token; the namespace is
/// length-prefixed (bytes), so no choice of namespace/key can collide with a
/// different pair.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct BucketPrefix(String);

impl BucketPrefix {
    pub fn new(tier: &str, namespace: &str) -> Self {
        Self(format!("{tier}/{}:{namespace}", namespace.len()))
    }

    /// The entry key of guest key `key` in this bucket.
    pub fn key(&self, key: &str) -> EntryKey {
        EntryKey(format!("{}{key}", self.0))
    }
}

/// A fully-qualified key inside a partition: bucket prefix + guest key.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) struct EntryKey(String);

impl EntryKey {
    #[cfg(test)]
    pub fn new(tier: &str, namespace: &str, key: &str) -> Self {
        BucketPrefix::new(tier, namespace).key(key)
    }

    fn len(&self) -> u64 {
        self.0.len() as u64
    }
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
    /// Ordered, so one bucket's entries (a shared key prefix) are a range.
    entries: BTreeMap<EntryKey, Entry>,
}

impl Partition {
    /// The entries of bucket `bucket` whose guest key starts with
    /// `key_prefix`, in key order.
    fn range<'a>(
        &'a self,
        bucket: &BucketPrefix,
        key_prefix: &str,
    ) -> impl Iterator<Item = (&'a EntryKey, &'a Entry)> + 'a {
        let start = bucket.key(key_prefix);
        let bounds = (Bound::Included(start.clone()), Bound::Unbounded);
        self.entries
            .range(bounds)
            .take_while(move |(k, _)| k.0.starts_with(&start.0))
    }
}

fn cost(entry_key: &EntryKey, value: &[u8]) -> u64 {
    entry_key.len() + value.len() as u64
}

/// A snapshot could not be written. The store stays dirty and keeps serving
/// from memory; the next flush retries.
#[derive(Debug)]
pub(crate) struct FlushError {
    path: PathBuf,
    source: io::Error,
}

impl fmt::Display for FlushError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "storage flush to {} failed: {}",
            self.path.display(),
            self.source
        )
    }
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
    scope: StorageScope,
    /// The owning module for `local`; empty for the shared `app` partition.
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
                    let id = match p.scope {
                        StorageScope::Local => PartitionId {
                            scope: p.scope,
                            owner: Some(ModuleName::new(p.owner)),
                        },
                        StorageScope::App if p.owner.is_empty() => PartitionId {
                            scope: p.scope,
                            owner: None,
                        },
                        StorageScope::App => {
                            return Err(invalid(&path, "the app partition has no owner"));
                        }
                        StorageScope::Cloud => {
                            return Err(invalid(&path, "cloud scope is never persisted"));
                        }
                    };
                    let mut part = Partition::default();
                    for (k, encoded) in p.entries {
                        let value = base64::engine::general_purpose::STANDARD
                            .decode(&encoded)
                            .map_err(|e| invalid(&path, format!("entry `{k}`: {e}")))?;
                        let key = EntryKey(k);
                        part.bytes = part.bytes.saturating_add(cost(&key, &value));
                        part.entries.insert(key, Entry { value, version: 1 });
                    }
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

    pub fn get(&self, part: &PartitionId, entry_key: &EntryKey) -> Option<&Entry> {
        self.partitions.get(part)?.entries.get(entry_key)
    }

    /// Unconditional write. Returns the entry's new version.
    pub fn set(
        &mut self,
        part: &PartitionId,
        entry_key: EntryKey,
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
        entry_key: EntryKey,
        expected: Option<u64>,
        value: Vec<u8>,
        quota: KvQuota,
    ) -> Result<u64, KvWriteError> {
        self.write(part, entry_key, value, quota, Some(expected))
    }

    fn write(
        &mut self,
        part: &PartitionId,
        entry_key: EntryKey,
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
            return Err(KvWriteError::QuotaExceeded(
                value_len - quota.max_value_bytes,
            ));
        }
        let old_cost = current.map_or(0, |e| cost(&entry_key, &e.value));
        let new_cost = cost(&entry_key, &value);
        let used = existing.map_or(0, |p| p.bytes);
        let next_used = used.saturating_sub(old_cost).saturating_add(new_cost);
        // Shrinking (or same-size) rewrites are always allowed so a module
        // can reduce its footprint even if the budget was lowered under it.
        if next_used > quota.max_partition_bytes && new_cost > old_cost {
            return Err(KvWriteError::QuotaExceeded(
                next_used - quota.max_partition_bytes,
            ));
        }

        let version = current_version.unwrap_or(0) + 1;
        let partition = self.partitions.entry(part.clone()).or_default();
        partition.bytes = next_used;
        partition
            .entries
            .insert(entry_key, Entry { value, version });
        self.mark_dirty(part);
        Ok(version)
    }

    /// Remove an entry. Returns whether it existed.
    pub fn delete(&mut self, part: &PartitionId, entry_key: &EntryKey) -> bool {
        let Some(partition) = self.partitions.get_mut(part) else {
            return false;
        };
        let Some(old) = partition.entries.remove(entry_key) else {
            return false;
        };
        partition.bytes = partition.bytes.saturating_sub(cost(entry_key, &old.value));
        if partition.entries.is_empty() {
            self.partitions.remove(part);
        }
        self.mark_dirty(part);
        true
    }

    /// Guest keys in `bucket` that start with `key_prefix`, in key order, at
    /// most `limit` of them.
    pub fn keys(
        &self,
        part: &PartitionId,
        bucket: &BucketPrefix,
        key_prefix: &str,
        limit: usize,
    ) -> Vec<String> {
        let Some(partition) = self.partitions.get(part) else {
            return Vec::new();
        };
        partition
            .range(bucket, key_prefix)
            .take(limit)
            // `range` only yields keys that start with the bucket prefix.
            .filter_map(|(k, _)| k.0.strip_prefix(&bucket.0).map(str::to_string))
            .collect()
    }

    /// Remove every entry of `bucket`. Returns how many were removed. Other
    /// buckets of the partition (other tiers / namespaces) are untouched.
    pub fn clear(&mut self, part: &PartitionId, bucket: &BucketPrefix) -> usize {
        let Some(partition) = self.partitions.get_mut(part) else {
            return 0;
        };
        let doomed: Vec<EntryKey> = partition
            .range(bucket, "")
            .map(|(k, _)| k.clone())
            .collect();
        for key in &doomed {
            if let Some(old) = partition.entries.remove(key) {
                partition.bytes = partition.bytes.saturating_sub(cost(key, &old.value));
            }
        }
        if partition.entries.is_empty() {
            self.partitions.remove(part);
        }
        if !doomed.is_empty() {
            self.mark_dirty(part);
        }
        doomed.len()
    }

    fn mark_dirty(&mut self, part: &PartitionId) {
        if part.is_persistent() && self.path.is_some() {
            self.dirty = true;
        }
    }

    /// Persist pending changes, if any. The hosts call this once at the end
    /// of every guest call. No-op for in-memory stores and when nothing
    /// changed. On failure the store stays dirty (and keeps serving from
    /// memory), so the next flush retries.
    pub fn flush(&mut self) -> Result<(), FlushError> {
        if !self.dirty {
            return Ok(());
        }
        let Some(path) = &self.path else {
            return Ok(());
        };

        let mut persistent: Vec<(&PartitionId, &Partition)> = self
            .partitions
            .iter()
            .filter(|(id, _)| id.is_persistent())
            .collect();
        persistent.sort_by_key(|(id, _)| *id);
        let snapshot = PersistedKv {
            format: FORMAT,
            partitions: persistent
                .into_iter()
                .map(|(id, partition)| PersistedPartition {
                    scope: id.scope,
                    owner: id
                        .owner
                        .as_ref()
                        .map(|o| o.as_str().to_string())
                        .unwrap_or_default(),
                    entries: partition
                        .entries
                        .iter()
                        .map(|(k, e)| {
                            (
                                k.0.clone(),
                                base64::engine::general_purpose::STANDARD.encode(&e.value),
                            )
                        })
                        .collect(),
                })
                .collect(),
        };
        let tmp = path.with_extension("json.tmp");
        let written = serde_json::to_vec(&snapshot)
            .map_err(io::Error::other)
            .and_then(|bytes| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, path));
        match written {
            Ok(()) => {
                self.dirty = false;
                Ok(())
            }
            Err(source) => Err(FlushError {
                path: path.clone(),
                source,
            }),
        }
    }
}

impl Drop for KvBackend {
    fn drop(&mut self) {
        // Last chance to persist; nobody is left to hand the error to.
        if let Err(e) = self.flush() {
            eprintln!("hypen: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTA: KvQuota = KvQuota {
        max_value_bytes: 64,
        max_partition_bytes: 200,
    };

    fn raw(key: &str) -> EntryKey {
        EntryKey(key.to_string())
    }

    fn local(module: &str) -> PartitionId {
        PartitionId::new(StorageScope::Local, &ModuleName::new(module))
    }

    #[test]
    fn entry_keys_do_not_alias_across_namespace_and_key() {
        assert_ne!(
            EntryKey::new("persistent", "a/b", "c"),
            EntryKey::new("persistent", "a", "b/c")
        );
        assert_ne!(
            EntryKey::new("persistent", "a", "1:b"),
            EntryKey::new("persistent", "a1:", "b")
        );
        assert_ne!(
            EntryKey::new("persistent", "", "x"),
            EntryKey::new("cache", "", "x")
        );
    }

    #[test]
    fn local_partitions_are_per_module_and_shared_scopes_are_not() {
        assert_ne!(local("a"), local("b"));
        assert_eq!(
            PartitionId::new(StorageScope::App, &ModuleName::new("a")),
            PartitionId::new(StorageScope::App, &ModuleName::new("b"))
        );
        assert_eq!(
            PartitionId::new(StorageScope::Cloud, &ModuleName::new("a")),
            PartitionId::new(StorageScope::Cloud, &ModuleName::new("b"))
        );
        // A module named like a shared scope's (empty) owner still can't
        // reach it: the scope is part of the id.
        assert_ne!(
            local(""),
            PartitionId::new(StorageScope::App, &ModuleName::new(""))
        );
    }

    #[test]
    fn quota_rejects_oversized_values_and_full_partitions() {
        let mut kv = KvBackend::default();
        let p = local("m");
        assert_eq!(
            kv.set(&p, raw("k"), vec![0; 65], QUOTA),
            Err(KvWriteError::QuotaExceeded(1))
        );
        // 3 × (2 + 64) = 198 bytes fit; the fourth entry is 64 over.
        for i in 0..3 {
            kv.set(&p, raw(&format!("k{i}")), vec![0; 64], QUOTA)
                .unwrap();
        }
        assert_eq!(
            kv.set(&p, raw("k3"), vec![0; 64], QUOTA),
            Err(KvWriteError::QuotaExceeded(64))
        );
        // Another module's budget is independent.
        kv.set(&local("other"), raw("k3"), vec![0; 64], QUOTA)
            .unwrap();
        // Overwriting in place and deleting free budget.
        kv.set(&p, raw("k0"), vec![0; 1], QUOTA).unwrap();
        kv.set(&p, raw("k3"), vec![0; 60], QUOTA).unwrap();
        assert!(kv.delete(&p, &raw("k1")));
        assert!(!kv.delete(&p, &raw("k1")));
    }

    #[test]
    fn compare_and_set_checks_the_version() {
        let mut kv = KvBackend::default();
        let p = PartitionId::new(StorageScope::Cloud, &ModuleName::new("m"));
        assert_eq!(
            kv.compare_and_set(&p, raw("k"), None, vec![1], QUOTA),
            Ok(1)
        );
        assert_eq!(
            kv.compare_and_set(&p, raw("k"), None, vec![2], QUOTA),
            Err(KvWriteError::VersionMismatch)
        );
        assert_eq!(
            kv.compare_and_set(&p, raw("k"), Some(1), vec![2], QUOTA),
            Ok(2)
        );
        assert_eq!(kv.set(&p, raw("k"), vec![3], QUOTA), Ok(3));
    }

    #[test]
    fn flushes_once_when_asked_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kv.json");
        {
            let mut kv = KvBackend::file_backed(path.clone()).unwrap();
            kv.set(
                &local("m"),
                EntryKey::new("persistent", "ns", "k"),
                vec![0, 255, 7],
                QUOTA,
            )
            .unwrap();
            kv.set(
                &PartitionId::new(StorageScope::Cloud, &ModuleName::new("m")),
                raw("c"),
                vec![1],
                QUOTA,
            )
            .unwrap();
            // Writes only mark the store dirty; nothing hits disk until flush.
            assert!(!path.exists());
            kv.flush().unwrap();
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(text.contains("\"AP8H\""), "values are base64: {text}");
            assert!(!text.contains("cloud"), "cloud is not persisted: {text}");
            // Dropping flushes whatever is still pending.
            kv.set(&local("m"), raw("late"), vec![9], QUOTA).unwrap();
        }
        let kv = KvBackend::file_backed(path).unwrap();
        assert_eq!(
            kv.get(&local("m"), &EntryKey::new("persistent", "ns", "k"))
                .unwrap()
                .value,
            vec![0, 255, 7]
        );
        assert_eq!(kv.get(&local("m"), &raw("late")).unwrap().value, vec![9]);
        assert!(kv.get(&local("other"), &raw("late")).is_none());
    }

    #[test]
    fn old_or_corrupt_files_are_errors_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [
            (
                "v1.json",
                r#"{"format":1,"plain":{"Local/Persistent/ns/k":[1,2]}}"#,
            ),
            ("noformat.json", r#"{"plain":{}}"#),
            ("garbage.json", "not json"),
            (
                "badvalue.json",
                r#"{"format":2,"partitions":[{"scope":"local","owner":"m","entries":{"k":"***"}}]}"#,
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            let err = match KvBackend::file_backed(path.clone()) {
                Ok(_) => panic!("{name} should not load"),
                Err(e) => e,
            };
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{name}");
            assert!(err.to_string().contains(name), "{name}: {err}");
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                body,
                "{name} untouched"
            );
        }
    }
}
