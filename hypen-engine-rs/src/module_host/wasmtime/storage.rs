//! `hypen:storage` over [`KvBackend`]: the one implementation both ABIs'
//! bucket imports delegate to.
//!
//! A bucket handle is a host resource holding the partition and the bucket's
//! key prefix. Both are fixed when the bucket is opened, from the scope of
//! the interface the guest called and the instance's *registered* module
//! name — a guest supplies only the tier, namespace and key, and none of
//! those can move it into another module's `local` partition.
//!
//! Scope access is a link-time fact (an ungranted scope's interface is not
//! linked), so nothing here checks grants.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use wasmtime::component::Resource;

use super::limits::{MAX_NAMESPACE_BYTES, MAX_OPEN_BUCKETS};
use super::store::HostState;
use crate::module_host::kv::{
    BucketPrefix, FlushError, KvBackend, KvQuota, KvWriteError, ModuleName, PartitionId,
};
use crate::module_host::StorageScope;

/// Durability tier (`hypen:storage/types.tier`). The dev backend stores all
/// tiers the same way; the tier only separates keyspaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    Persistent,
    Cache,
    Temp,
    Secure,
}

impl Tier {
    fn token(self) -> &'static str {
        match self {
            Tier::Persistent => "persistent",
            Tier::Cache => "cache",
            Tier::Temp => "temp",
            Tier::Secure => "secure",
        }
    }
}

/// `hypen:storage/types.error`, minus the cases this backend never produces.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StorageError {
    /// Over quota by this many bytes.
    QuotaExceeded(u64),
    /// The request cannot be served (unimplemented surface, a host bound,
    /// a compare-and-set version mismatch — the WIT's designated error).
    Unavailable(String),
    /// A host-side failure the guest cannot act on.
    Backend(String),
}

impl From<KvWriteError> for StorageError {
    fn from(e: KvWriteError) -> Self {
        match e {
            KvWriteError::QuotaExceeded(over) => StorageError::QuotaExceeded(over),
            KvWriteError::VersionMismatch => StorageError::Unavailable("version mismatch".into()),
        }
    }
}

/// `hypen:storage/types.entry-info`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EntryMeta {
    pub size: u64,
    /// When the entry was last written: ms since the Unix epoch by the
    /// writing instance's host clock (`hypen:time`'s wall clock — virtual
    /// when the host's is). 0 for an entry persisted before modification
    /// times were tracked.
    pub modified_ms: u64,
    /// `Some` on `cloud` only (the scope with concurrent writers).
    pub version: Option<u64>,
}

/// Host type behind every `bucket` resource, in all three scopes and both
/// ABIs.
pub struct Bucket {
    partition: PartitionId,
    prefix: BucketPrefix,
}

/// Host type behind the blob resources. Blobs are not implemented: `open`
/// answers `unavailable`, so a guest never holds one of these.
pub struct Blob;

/// The storage backend, shared by every instance of a host (and by both
/// hosts of a `DualHost`).
#[derive(Clone)]
pub(crate) struct SharedKv(Arc<Mutex<KvBackend>>);

impl SharedKv {
    pub(crate) fn new(backend: KvBackend) -> Self {
        Self(Arc::new(Mutex::new(backend)))
    }

    /// The lock is only ever held for one map operation, with no guest code
    /// and no `await` inside. A poisoned lock therefore means a panic in the
    /// backend itself; its data is still the best available, so keep
    /// serving rather than poisoning every later call.
    fn lock(&self) -> MutexGuard<'_, KvBackend> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Swap the backend (dropping, and so flushing, the old one).
    pub(crate) fn replace(&self, backend: KvBackend) {
        *self.lock() = backend;
    }

    pub(crate) fn flush(&self) -> Result<(), FlushError> {
        self.lock().flush()
    }
}

/// An instance's view of storage.
pub(crate) struct StorageCtx {
    kv: SharedKv,
    quota: KvQuota,
    /// Registered name of the module this instance belongs to — the owner of
    /// its `local` partition.
    module: ModuleName,
    /// Bucket handles currently open (bounded by [`MAX_OPEN_BUCKETS`]).
    open_buckets: usize,
}

impl StorageCtx {
    pub(crate) fn new(module: ModuleName, kv: SharedKv, quota: KvQuota) -> Self {
        Self {
            kv,
            quota,
            module,
            open_buckets: 0,
        }
    }
}

fn unimplemented_blob() -> StorageError {
    StorageError::Unavailable("blob storage is not implemented by this host".into())
}

/// The storage operations, in neutral types. Each ABI's generated bucket
/// traits forward here and convert at the edge.
impl HostState {
    pub(crate) fn bucket_open(
        &mut self,
        scope: StorageScope,
        tier: Tier,
        namespace: &str,
    ) -> Result<Resource<Bucket>, StorageError> {
        if namespace.len() > MAX_NAMESPACE_BYTES {
            return Err(StorageError::Unavailable(format!(
                "namespace of {} bytes exceeds the {MAX_NAMESPACE_BYTES}-byte limit",
                namespace.len()
            )));
        }
        if self.storage.open_buckets >= MAX_OPEN_BUCKETS {
            return Err(StorageError::Unavailable(format!(
                "too many open buckets (limit {MAX_OPEN_BUCKETS}); drop unused handles"
            )));
        }
        let bucket = Bucket {
            partition: PartitionId::new(scope, &self.storage.module),
            prefix: BucketPrefix::new(tier.token(), namespace),
        };
        let handle = self
            .table
            .push(bucket)
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        self.storage.open_buckets += 1;
        Ok(handle)
    }

    /// Resource destructor.
    pub(crate) fn bucket_drop(&mut self, handle: Resource<Bucket>) -> wasmtime::Result<()> {
        self.table.delete(handle)?;
        self.storage.open_buckets = self.storage.open_buckets.saturating_sub(1);
        Ok(())
    }

    fn bucket(&self, handle: &Resource<Bucket>) -> Result<&Bucket, StorageError> {
        self.table
            .get(handle)
            .map_err(|e| StorageError::Backend(e.to_string()))
    }

    pub(crate) fn bucket_get(
        &self,
        handle: &Resource<Bucket>,
        key: &str,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        let bucket = self.bucket(handle)?;
        let kv = self.storage.kv.lock();
        Ok(kv
            .get(&bucket.partition, &bucket.prefix.key(key))
            .map(|e| e.value.clone()))
    }

    pub(crate) fn bucket_set(
        &self,
        handle: &Resource<Bucket>,
        key: &str,
        value: Vec<u8>,
    ) -> Result<(), StorageError> {
        let bucket = self.bucket(handle)?;
        let now_ms = self.clock.now_ms();
        let mut kv = self.storage.kv.lock();
        kv.set(
            &bucket.partition,
            bucket.prefix.key(key),
            value,
            self.storage.quota,
            now_ms,
        )?;
        Ok(())
    }

    /// Versioned write (`cloud` only in the WIT). Returns the new version.
    pub(crate) fn bucket_compare_and_set(
        &self,
        handle: &Resource<Bucket>,
        key: &str,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        let bucket = self.bucket(handle)?;
        let now_ms = self.clock.now_ms();
        let mut kv = self.storage.kv.lock();
        let entry_key = bucket.prefix.key(key);
        Ok(kv.compare_and_set(
            &bucket.partition,
            entry_key,
            expected,
            value,
            self.storage.quota,
            now_ms,
        )?)
    }

    pub(crate) fn bucket_delete(
        &self,
        handle: &Resource<Bucket>,
        key: &str,
    ) -> Result<bool, StorageError> {
        let bucket = self.bucket(handle)?;
        Ok(self
            .storage
            .kv
            .lock()
            .delete(&bucket.partition, &bucket.prefix.key(key)))
    }

    /// Keys of this bucket starting with `prefix`, in key order, at most
    /// `limit`.
    pub(crate) fn bucket_keys(
        &self,
        handle: &Resource<Bucket>,
        prefix: &str,
        limit: u32,
    ) -> Result<Vec<String>, StorageError> {
        let bucket = self.bucket(handle)?;
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        Ok(self
            .storage
            .kv
            .lock()
            .keys(&bucket.partition, &bucket.prefix, prefix, limit))
    }

    pub(crate) fn bucket_info(
        &self,
        handle: &Resource<Bucket>,
        key: &str,
    ) -> Result<Option<EntryMeta>, StorageError> {
        let bucket = self.bucket(handle)?;
        let kv = self.storage.kv.lock();
        Ok(kv
            .get(&bucket.partition, &bucket.prefix.key(key))
            .map(|e| EntryMeta {
                size: e.value.len() as u64,
                modified_ms: e.modified_ms,
                // Versions are a `cloud` concept (concurrent writers).
                version: (bucket.partition.scope() == StorageScope::Cloud).then_some(e.version),
            }))
    }

    /// Remove every key of this bucket — this `(tier, namespace)` of the
    /// partition, nothing else.
    pub(crate) fn bucket_clear(&self, handle: &Resource<Bucket>) -> Result<(), StorageError> {
        let bucket = self.bucket(handle)?;
        self.storage
            .kv
            .lock()
            .clear(&bucket.partition, &bucket.prefix);
        Ok(())
    }

    /// Every blob operation: the surface exists in the WIT but this host
    /// does not implement it, and says so rather than faking an empty store.
    pub(crate) fn blob_unavailable<T>(&self) -> Result<T, StorageError> {
        Err(unimplemented_blob())
    }

    /// Resource destructor for the blob types. Unreachable in practice (no
    /// blob handle is ever issued) but must exist for the generated traits.
    pub(crate) fn blob_drop(&mut self, handle: Resource<Blob>) -> wasmtime::Result<()> {
        self.table.delete(handle)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_host::wasmtime::limits::ModuleLimits;
    use crate::module_host::wasmtime::store::HostClock;

    fn state(module: &str, kv: &SharedKv) -> HostState {
        let limits = ModuleLimits {
            max_storage_value_bytes: 16,
            ..ModuleLimits::default()
        };
        HostState::new(
            ModuleName::new(module),
            kv.clone(),
            HostClock::real(),
            &limits,
        )
    }

    fn kv() -> SharedKv {
        SharedKv::new(KvBackend::default())
    }

    #[test]
    fn keys_lists_one_bucket_by_prefix_in_order_up_to_the_limit() {
        let kv = kv();
        let mut s = state("m", &kv);
        let prefs = s
            .bucket_open(StorageScope::Local, Tier::Persistent, "prefs")
            .unwrap();
        let other = s
            .bucket_open(StorageScope::Local, Tier::Persistent, "prefs2")
            .unwrap();
        let cache = s
            .bucket_open(StorageScope::Local, Tier::Cache, "prefs")
            .unwrap();
        for key in ["b/2", "a", "b/1", "c"] {
            s.bucket_set(&prefs, key, vec![1]).unwrap();
        }
        s.bucket_set(&other, "b/9", vec![1]).unwrap();
        s.bucket_set(&cache, "b/8", vec![1]).unwrap();

        assert_eq!(
            s.bucket_keys(&prefs, "", 10).unwrap(),
            ["a", "b/1", "b/2", "c"]
        );
        assert_eq!(s.bucket_keys(&prefs, "b/", 10).unwrap(), ["b/1", "b/2"]);
        assert_eq!(s.bucket_keys(&prefs, "b/", 1).unwrap(), ["b/1"]);
        assert_eq!(
            s.bucket_keys(&prefs, "b/", 0).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            s.bucket_keys(&prefs, "zzz", u32::MAX).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(s.bucket_keys(&other, "", 10).unwrap(), ["b/9"]);
    }

    #[test]
    fn clear_empties_exactly_one_bucket_and_frees_its_quota() {
        let kv = kv();
        let mut a = state("a", &kv);
        let mut b = state("b", &kv);
        let a_prefs = a
            .bucket_open(StorageScope::Local, Tier::Persistent, "prefs")
            .unwrap();
        let a_drafts = a
            .bucket_open(StorageScope::Local, Tier::Persistent, "drafts")
            .unwrap();
        let b_prefs = b
            .bucket_open(StorageScope::Local, Tier::Persistent, "prefs")
            .unwrap();
        a.bucket_set(&a_prefs, "k1", vec![1]).unwrap();
        a.bucket_set(&a_prefs, "k2", vec![2]).unwrap();
        a.bucket_set(&a_drafts, "k1", vec![3]).unwrap();
        b.bucket_set(&b_prefs, "k1", vec![4]).unwrap();

        a.bucket_clear(&a_prefs).unwrap();
        assert_eq!(a.bucket_get(&a_prefs, "k1").unwrap(), None);
        assert_eq!(
            a.bucket_keys(&a_prefs, "", 10).unwrap(),
            Vec::<String>::new()
        );
        // The same module's other namespace and another module's same
        // namespace are untouched.
        assert_eq!(a.bucket_get(&a_drafts, "k1").unwrap(), Some(vec![3]));
        assert_eq!(b.bucket_get(&b_prefs, "k1").unwrap(), Some(vec![4]));
        // Clearing an empty bucket is fine.
        a.bucket_clear(&a_prefs).unwrap();
    }

    #[test]
    fn info_reports_size_and_versions_only_on_cloud() {
        let kv = kv();
        let mut s = state("m", &kv);
        // A virtual clock, so the write stamps are exact.
        let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
        s.clock = HostClock::Virtual(Arc::clone(&now));
        let local = s
            .bucket_open(StorageScope::Local, Tier::Persistent, "n")
            .unwrap();
        let cloud = s
            .bucket_open(StorageScope::Cloud, Tier::Persistent, "n")
            .unwrap();
        assert_eq!(s.bucket_info(&local, "k").unwrap(), None);
        s.bucket_set(&local, "k", vec![0; 5]).unwrap();
        s.bucket_set(&cloud, "k", vec![0; 3]).unwrap();
        now.store(2_500, std::sync::atomic::Ordering::Relaxed);
        s.bucket_set(&cloud, "k", vec![0; 4]).unwrap();
        assert_eq!(
            s.bucket_info(&local, "k").unwrap(),
            Some(EntryMeta {
                size: 5,
                modified_ms: 1_000,
                version: None
            })
        );
        assert_eq!(
            s.bucket_info(&cloud, "k").unwrap(),
            Some(EntryMeta {
                size: 4,
                modified_ms: 2_500,
                version: Some(2)
            })
        );
    }

    /// `modified-ms` follows the writer's clock: a compare-and-set stamps
    /// like a set, a refused write stamps nothing, and another instance
    /// reading the shared scope sees the writer's stamp.
    #[test]
    fn modified_ms_is_the_writers_clock_at_the_last_successful_write() {
        let kv = kv();
        let mut writer = state("w", &kv);
        let mut reader = state("r", &kv);
        let now = Arc::new(std::sync::atomic::AtomicU64::new(10));
        writer.clock = HostClock::Virtual(Arc::clone(&now));
        let set_now = |ms| now.store(ms, std::sync::atomic::Ordering::Relaxed);

        let w = writer
            .bucket_open(StorageScope::Cloud, Tier::Persistent, "n")
            .unwrap();
        let r = reader
            .bucket_open(StorageScope::Cloud, Tier::Persistent, "n")
            .unwrap();
        let modified = |s: &HostState, b| s.bucket_info(b, "k").unwrap().map(|i| i.modified_ms);

        assert_eq!(writer.bucket_compare_and_set(&w, "k", None, vec![1]), Ok(1));
        assert_eq!(modified(&reader, &r), Some(10));
        set_now(20);
        // Stale version and an over-quota value: refused, stamp unchanged.
        assert!(writer.bucket_compare_and_set(&w, "k", Some(7), vec![2]).is_err());
        assert!(writer.bucket_set(&w, "k", vec![0; 17]).is_err());
        assert_eq!(modified(&reader, &r), Some(10));
        assert_eq!(writer.bucket_compare_and_set(&w, "k", Some(1), vec![2]), Ok(2));
        assert_eq!(modified(&reader, &r), Some(20));
        assert!(writer.bucket_delete(&w, "k").unwrap());
        assert_eq!(modified(&reader, &r), None);
    }

    #[test]
    fn write_failures_map_to_the_wit_errors() {
        let kv = kv();
        let mut s = state("m", &kv);
        let cloud = s
            .bucket_open(StorageScope::Cloud, Tier::Persistent, "n")
            .unwrap();
        assert_eq!(
            s.bucket_set(&cloud, "k", vec![0; 17]),
            Err(StorageError::QuotaExceeded(1))
        );
        assert_eq!(s.bucket_compare_and_set(&cloud, "k", None, vec![1]), Ok(1));
        assert_eq!(
            s.bucket_compare_and_set(&cloud, "k", None, vec![2]),
            Err(StorageError::Unavailable("version mismatch".into()))
        );
    }

    /// Bucket handles pin host memory (the namespace), so both their number
    /// and the namespace length are bounded; dropping a handle frees a slot.
    #[test]
    fn open_buckets_and_namespaces_are_bounded() {
        let kv = kv();
        let mut s = state("m", &kv);
        let long = "n".repeat(MAX_NAMESPACE_BYTES + 1);
        let Err(StorageError::Unavailable(why)) =
            s.bucket_open(StorageScope::Local, Tier::Persistent, &long)
        else {
            panic!("oversized namespace accepted")
        };
        assert!(why.contains("namespace"), "{why}");

        let mut handles = Vec::new();
        for i in 0..MAX_OPEN_BUCKETS {
            let ns = format!("ns{i}");
            handles.push(
                s.bucket_open(StorageScope::Local, Tier::Persistent, &ns)
                    .unwrap(),
            );
        }
        let Err(StorageError::Unavailable(why)) =
            s.bucket_open(StorageScope::Local, Tier::Persistent, "one-more")
        else {
            panic!("bucket over the limit accepted")
        };
        assert!(why.contains("too many open buckets"), "{why}");

        let freed = handles.pop().expect("opened above");
        s.bucket_drop(freed).unwrap();
        s.bucket_open(StorageScope::Local, Tier::Persistent, "one-more")
            .unwrap();
    }

    /// A handle the table does not know (stale, or of another type) is an
    /// error to the guest, never a panic.
    #[test]
    fn a_stale_handle_is_a_backend_error() {
        let kv = kv();
        let mut s = state("m", &kv);
        let bucket = s
            .bucket_open(StorageScope::Local, Tier::Persistent, "n")
            .unwrap();
        let stale = Resource::<Bucket>::new_own(bucket.rep());
        s.bucket_drop(bucket).unwrap();
        assert!(matches!(
            s.bucket_get(&stale, "k"),
            Err(StorageError::Backend(_))
        ));
        assert!(matches!(
            s.bucket_set(&stale, "k", vec![]),
            Err(StorageError::Backend(_))
        ));
        assert!(matches!(
            s.bucket_clear(&stale),
            Err(StorageError::Backend(_))
        ));
        assert!(s.bucket_drop(stale).is_err());
    }

    #[test]
    fn blobs_report_unavailable() {
        let kv = kv();
        let s = state("m", &kv);
        assert!(matches!(
            s.blob_unavailable::<()>(),
            Err(StorageError::Unavailable(_))
        ));
    }
}
