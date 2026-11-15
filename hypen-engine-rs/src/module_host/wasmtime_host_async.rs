//! Native [`ModuleHost`] for the **CM-async** `hypen:module@0.2.0` world.
//!
//! The v0.2 counterpart of [`super::wasmtime_host::WasmtimeHost`]: loads
//! components whose reducer + lifecycle exports are WIT `async func`, so a
//! module `await`s its capability imports (storage, cross-module state)
//! *inline* and returns the delta when done — no effect-descriptor round
//! trip. The engine-facing surface is the same synchronous [`ModuleHost`]
//! trait: each call drives wasmtime's component event loop to completion
//! via `Store::run_concurrent` under a `block_on`.
//!
//! Mechanics (wasmtime 46, `component-model-async` — a default feature):
//! - WIT `async func` makes `bindgen!` emit concurrent bindings with no
//!   extra options: exports become `call_x(accessor, ...)` futures, imports
//!   land on `*WithStore` traits taking an `&Accessor`.
//! - Once any CM-async import is linked the store requires async
//!   entrypoints for everything, so the sync `actions` export is lifted
//!   onto the concurrent path too (`exports: { "actions": async | store }`)
//!   and instantiation goes through `instantiate_async`.
//! - Every call is driven by the host's current-thread tokio runtime under
//!   the same two deadlines as the v0.1 host (see
//!   [`super::wasmtime_host`]): epoch interruption for guest CPU, and a
//!   `tokio::time::timeout` that cancels a call parked in a host call
//!   (`hypen:time.sleep-ms`, wasi:io poll, wasi:http). A trapped or
//!   timed-out instance is dead.
//! - wasi:http is the p2 surface (async host implementation): v0.2 modules
//!   are expected to move to `wasi:http/client@0.3.0` once
//!   `wasmtime-wasi-http`'s p3 surface stabilizes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use slotmap::{new_key_type, Key, SlotMap};

new_key_type! {
    struct InstKey;
}

use wasmtime::component::{
    Accessor, Component, HasData, Linker, Resource, ResourceTable, StreamReader,
};
use wasmtime::Store;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};
use wasmtime_wasi_http::WasiHttpCtx;

use super::{
    Effect, HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleManifest, SiblingState,
    StorageScope,
};

// The v0.2 async world. WIT-declared `async func` gets ASYNC|STORE flags
// automatically; only the sync `actions` export needs lifting onto the
// concurrent call path (the store is async-required once CM-async imports
// are linked). Resource `with` keys use the 46-era dot form.
wasmtime::component::bindgen!({
    path: "../wit-v0_2",
    world: "module-x",
    with: {
        "hypen:storage/local.bucket": BucketData,
        "hypen:storage/app.bucket": BucketData,
        "hypen:storage/cloud.bucket": BucketData,
        "hypen:storage/local.blob-bucket": BlobBucketData,
        "hypen:storage/app.blob-bucket": BlobBucketData,
        "hypen:storage/cloud.blob-bucket": BlobBucketData,
    },
    exports: { "actions": async | store },
});

use hypen::storage::types::{EntryInfo, Error as StorageError, Tier};

// ── storage backend (shared with the v0.1 host) ────────────────────────────

/// Host type behind every `bucket` resource (all three scopes map here).
pub struct BucketData {
    /// Which partition of the backend this bucket addresses. Derived from the
    /// scope and the instance's *registered* module name — not guest input.
    partition: PartitionId,
    tier: Tier,
    namespace: String,
}
/// Blob host type — blobs are stubbed until the stream plumbing matures
/// (`stream<u8>` signatures pass through bindgen; impls return
/// `unavailable`).
pub struct BlobBucketData;

use super::kv::{entry_key, KvBackend, KvQuota, KvScope, KvWriteError, PartitionId};
use super::wasmtime_host::{CrossModuleCtx, CrossModuleError, HostCore, TotalMemoryLimiter};

fn tier_token(tier: Tier) -> &'static str {
    match tier {
        Tier::Persistent => "persistent",
        Tier::Cache => "cache",
        Tier::Temp => "temp",
        Tier::Secure => "secure",
    }
}

fn storage_error(e: KvWriteError) -> StorageError {
    match e {
        KvWriteError::QuotaExceeded(over) => StorageError::QuotaExceeded(over),
        KvWriteError::VersionMismatch => StorageError::Unavailable("version mismatch".into()),
    }
}

// ── hypen:time clock ────────────────────────────────────────────────────────

/// The clock behind `hypen:time/clock`. `Real` reads the OS; `Virtual` is a
/// counter — reads return it, `sleep-ms` advances it without waiting — which
/// makes reducer runs deterministically replayable.
#[derive(Clone)]
pub enum HostClock {
    Real {
        /// Origin for `monotonic-ms`.
        origin: Instant,
    },
    Virtual(Arc<AtomicU64>),
}

impl HostClock {
    fn real() -> Self {
        Self::Real { origin: Instant::now() }
    }
    fn now_ms(&self) -> u64 {
        match self {
            Self::Real { .. } => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            Self::Virtual(c) => c.load(Ordering::Relaxed),
        }
    }
    fn monotonic_ms(&self) -> u64 {
        match self {
            Self::Real { origin } => origin.elapsed().as_millis() as u64,
            Self::Virtual(c) => c.load(Ordering::Relaxed),
        }
    }
}

pub use super::wasmtime_host::ModuleLimits;

struct HostState {
    table: ResourceTable,
    /// Per-instance total-memory limiter (see [`ModuleLimits`]).
    limiter: TotalMemoryLimiter,
    wasi: WasiCtx,
    /// wasi:http config, used only when the manifest grants egress.
    http: WasiHttpCtx,
    kv: Arc<Mutex<KvBackend>>,
    quota: KvQuota,
    /// Registered name of the module this instance belongs to — the owner of
    /// its `local` storage partition.
    module: String,
    clock: HostClock,
    /// Per-call cross-module context, same model as the v0.1 host.
    cross: CrossModuleCtx,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for HostState {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: wasmtime_wasi_http::p2::default_hooks(),
        }
    }
}

/// `HasData` marker projecting the store data for the `*WithStore` capability
/// impls (CM-async imports don't borrow the store across await points; they
/// get synchronous windows via `Accessor::with`).
struct HostCap;

impl HasData for HostCap {
    type Data<'a> = &'a mut HostState;
}

impl HostState {
    fn open(&mut self, scope: KvScope, tier: Tier, namespace: String) -> Result<Resource<BucketData>, StorageError> {
        let partition = PartitionId::new(scope, &self.module);
        self.table
            .push(BucketData { partition, tier, namespace })
            .map_err(|e| StorageError::Backend(e.to_string()))
    }
    /// Resolve a bucket handle + guest key to `(partition, entry key)`.
    fn locate(&self, res: &Resource<BucketData>, key: &str) -> Result<(PartitionId, String), StorageError> {
        let b = self
            .table
            .get(res)
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok((b.partition.clone(), entry_key(tier_token(b.tier), &b.namespace, key)))
    }
    fn b_get(&mut self, res: &Resource<BucketData>, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let (part, ek) = self.locate(res, key)?;
        let kv = self.kv.lock().unwrap();
        Ok(kv.get(&part, &ek).map(|e| e.value.clone()))
    }
    fn b_set(&mut self, res: &Resource<BucketData>, key: &str, value: Vec<u8>) -> Result<(), StorageError> {
        let (part, ek) = self.locate(res, key)?;
        let mut kv = self.kv.lock().unwrap();
        kv.set(&part, ek, value, self.quota).map(|_| ()).map_err(storage_error)
    }
    fn b_delete(&mut self, res: &Resource<BucketData>, key: &str) -> Result<bool, StorageError> {
        let (part, ek) = self.locate(res, key)?;
        Ok(self.kv.lock().unwrap().delete(&part, &ek))
    }
    fn b_compare_and_set(
        &mut self,
        res: &Resource<BucketData>,
        key: &str,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        let (part, ek) = self.locate(res, key)?;
        let mut kv = self.kv.lock().unwrap();
        kv.compare_and_set(&part, ek, expected, value, self.quota)
            .map_err(storage_error)
    }
    fn b_info(&mut self, res: &Resource<BucketData>, key: &str) -> Result<Option<EntryInfo>, StorageError> {
        let (part, ek) = self.locate(res, key)?;
        let kv = self.kv.lock().unwrap();
        Ok(kv.get(&part, &ek).map(|e| EntryInfo {
            size: e.value.len() as u64,
            modified_ms: 0,
            // Versions are a `cloud` concept (concurrent writers).
            version: (part.scope() == KvScope::Cloud).then_some(e.version),
        }))
    }
}

// ── capability impls ────────────────────────────────────────────────────────
//
// WIT `async func` imports land on `*WithStore` traits whose methods take an
// `&Accessor` and return futures. Our backends are in-memory, so every impl
// is an immediately-ready future around a synchronous `Accessor::with`
// window — but the guest still suspends and resumes through the component
// event loop, which is exactly the ABI surface v0.2 needs proven.

macro_rules! impl_async_kv_bucket {
    ($iface:path, $scope:expr) => {
        const _: () = {
            use $iface as iface;
            impl iface::HostBucketWithStore<HostState> for HostCap {
                async fn open(
                    accessor: &Accessor<HostState, Self>,
                    tier: Tier,
                    namespace: String,
                ) -> Result<Resource<BucketData>, StorageError> {
                    accessor.with(|mut a| a.get().open($scope, tier, namespace))
                }
                async fn get(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                ) -> Result<Option<Vec<u8>>, StorageError> {
                    accessor.with(|mut a| a.get().b_get(&s, &key))
                }
                async fn set(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                    value: Vec<u8>,
                ) -> Result<(), StorageError> {
                    accessor.with(|mut a| a.get().b_set(&s, &key, value))
                }
                async fn delete(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                ) -> Result<bool, StorageError> {
                    accessor.with(|mut a| a.get().b_delete(&s, &key))
                }
                async fn keys(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BucketData>,
                    _prefix: String,
                    _limit: u32,
                ) -> Result<Vec<String>, StorageError> {
                    Ok(vec![])
                }
                async fn info(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                ) -> Result<Option<EntryInfo>, StorageError> {
                    accessor.with(|mut a| a.get().b_info(&s, &key))
                }
                async fn clear(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BucketData>,
                ) -> Result<(), StorageError> {
                    Ok(())
                }
            }
            impl iface::HostBucket for HostState {
                fn drop(&mut self, rep: Resource<BucketData>) -> wasmtime::Result<()> {
                    self.table.delete(rep)?;
                    Ok(())
                }
            }
        };
    };
}

macro_rules! impl_async_blob_bucket {
    ($iface:path) => {
        const _: () = {
            use $iface as iface;
            impl iface::HostBlobBucketWithStore<HostState> for HostCap {
                async fn open(
                    _accessor: &Accessor<HostState, Self>,
                    _tier: Tier,
                    _namespace: String,
                ) -> Result<Resource<BlobBucketData>, StorageError> {
                    Err(StorageError::Unavailable("blob unimplemented".into()))
                }
                async fn get(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BlobBucketData>,
                    _key: String,
                ) -> Result<Option<StreamReader<u8>>, StorageError> {
                    Ok(None)
                }
                async fn put(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BlobBucketData>,
                    _key: String,
                    _contents: StreamReader<u8>,
                ) -> Result<EntryInfo, StorageError> {
                    Err(StorageError::Unavailable("blob unimplemented".into()))
                }
                async fn delete(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BlobBucketData>,
                    _key: String,
                ) -> Result<bool, StorageError> {
                    Ok(false)
                }
                async fn keys(
                    _accessor: &Accessor<HostState, Self>,
                    _s: Resource<BlobBucketData>,
                    _prefix: String,
                    _limit: u32,
                ) -> Result<Vec<String>, StorageError> {
                    Ok(vec![])
                }
            }
            impl iface::HostBlobBucket for HostState {
                fn drop(&mut self, rep: Resource<BlobBucketData>) -> wasmtime::Result<()> {
                    self.table.delete(rep)?;
                    Ok(())
                }
            }
        };
    };
}

impl_async_kv_bucket!(hypen::storage::local, KvScope::Local);
impl_async_kv_bucket!(hypen::storage::app, KvScope::App);
impl_async_blob_bucket!(hypen::storage::local);
impl_async_blob_bucket!(hypen::storage::app);
impl_async_blob_bucket!(hypen::storage::cloud);

// cloud adds compare-and-set, so its bucket impl is spelled out.
impl hypen::storage::cloud::HostBucketWithStore<HostState> for HostCap {
    async fn open(
        accessor: &Accessor<HostState, Self>,
        tier: Tier,
        namespace: String,
    ) -> Result<Resource<BucketData>, StorageError> {
        accessor.with(|mut a| a.get().open(KvScope::Cloud, tier, namespace))
    }
    async fn get(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        accessor.with(|mut a| a.get().b_get(&s, &key))
    }
    async fn set(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
        value: Vec<u8>,
    ) -> Result<(), StorageError> {
        accessor.with(|mut a| a.get().b_set(&s, &key, value))
    }
    async fn delete(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
    ) -> Result<bool, StorageError> {
        accessor.with(|mut a| a.get().b_delete(&s, &key))
    }
    async fn keys(
        _accessor: &Accessor<HostState, Self>,
        _s: Resource<BucketData>,
        _prefix: String,
        _limit: u32,
    ) -> Result<Vec<String>, StorageError> {
        Ok(vec![])
    }
    async fn info(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
    ) -> Result<Option<EntryInfo>, StorageError> {
        accessor.with(|mut a| a.get().b_info(&s, &key))
    }
    async fn compare_and_set(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        accessor.with(|mut a| a.get().b_compare_and_set(&s, &key, expected, value))
    }
}
impl hypen::storage::cloud::HostBucket for HostState {
    fn drop(&mut self, rep: Resource<BucketData>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl hypen::storage::local::Host for HostState {}
impl hypen::storage::app::Host for HostState {}
impl hypen::storage::cloud::Host for HostState {}
impl hypen::storage::types::Host for HostState {}
impl hypen::module::types::Host for HostState {}

impl From<CrossModuleError> for hypen::engine::state::Error {
    fn from(e: CrossModuleError) -> Self {
        match e {
            CrossModuleError::NotFound => Self::NotFound,
            CrossModuleError::PermissionDenied(grant) => Self::PermissionDenied(grant.into()),
            // The WIT has no dedicated "limit" case; `module-error` carries
            // the human-readable reason.
            CrossModuleError::Limit(why) => Self::ModuleError(why),
        }
    }
}

// Cross-module state capability — async in v0.2, same call-time ACL model.
impl hypen::engine::state::HostWithStore<HostState> for HostCap {
    async fn read(
        accessor: &Accessor<HostState, Self>,
        module: String,
    ) -> Result<Vec<u8>, hypen::engine::state::Error> {
        Ok(accessor.with(|mut a| a.get().cross.read(&module))?)
    }

    async fn dispatch(
        accessor: &Accessor<HostState, Self>,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        let action = HostAction { name: action.name, payload: action.payload };
        Ok(accessor.with(|mut a| a.get().cross.dispatch(module, action))?)
    }

    async fn subscribe(
        accessor: &Accessor<HostState, Self>,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), hypen::engine::state::Error> {
        Ok(accessor.with(|mut a| a.get().cross.subscribe(module, path, on_change))?)
    }
}
impl hypen::engine::state::Host for HostState {}

// hypen:time — the first post-pioneer stdlib capability. Reads are sync
// (never block); sleep is CM-async so the guest task suspends through the
// component event loop. A virtual clock resumes instantly and advances the
// counter, which is what makes replay deterministic.
impl hypen::time::clock::Host for HostState {
    fn now_ms(&mut self) -> u64 {
        self.clock.now_ms()
    }
    fn monotonic_ms(&mut self) -> u64 {
        self.clock.monotonic_ms()
    }
}

impl hypen::time::clock::HostWithStore<HostState> for HostCap {
    async fn sleep_ms(accessor: &Accessor<HostState, Self>, ms: u64) {
        let clock = accessor.with(|mut a| a.get().clock.clone());
        match clock {
            HostClock::Virtual(c) => {
                c.fetch_add(ms, Ordering::Relaxed);
            }
            HostClock::Real { .. } => {
                // Suspends the guest task on the host's runtime (the host
                // thread is not parked). No cap needed: the per-call timeout
                // cancels the call if the sleep outlives the budget.
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
        }
    }
}

// ── WIT ⇆ engine type conversions ───────────────────────────────────────────

fn from_wit_level(level: hypen::module::types::LogLevel) -> super::LogLevel {
    use hypen::module::types::LogLevel as L;
    match level {
        L::Trace => super::LogLevel::Trace,
        L::Debug => super::LogLevel::Debug,
        L::Info => super::LogLevel::Info,
        L::Warn => super::LogLevel::Warn,
        L::Error => super::LogLevel::Error,
    }
}

fn from_wit_effect(e: hypen::module::types::Effect) -> Effect {
    use hypen::module::types::Effect as E;
    match e {
        E::Delay(d) => Effect::Delay { ms: d.ms, then: d.then },
        E::Navigate(path) => Effect::Navigate(path),
        E::Log(l) => Effect::Log {
            level: from_wit_level(l.level),
            message: l.message,
        },
    }
}

fn from_wit_output(o: hypen::module::types::ReducerOutput) -> super::ReducerOutput {
    super::ReducerOutput {
        state: o.state,
        effects: o.effects.into_iter().map(from_wit_effect).collect(),
        emit: o
            .emit
            .into_iter()
            .map(|a| HostAction { name: a.name, payload: a.payload })
            .collect(),
        cross_dispatch: Vec::new(),
        subscribe_requests: Vec::new(),
    }
}

type ActionWit = hypen::module::types::Action;

// ── the host ────────────────────────────────────────────────────────────────

struct RegisteredModule {
    component: Component,
    linker: Linker<HostState>,
    manifest: ModuleManifest,
}

struct InstanceData {
    store: Store<HostState>,
    bindings: ModuleX,
    type_name: String,
}

/// Native host for `hypen:module@0.2.0` CM-async components. Sync-facing
/// ([`ModuleHost`]); each call pumps the store's concurrent event loop to
/// completion on the host's runtime, under the per-call deadline.
pub struct WasmtimeHostAsync {
    core: Arc<HostCore>,
    modules: HashMap<String, RegisteredModule>,
    /// `None` marks an instance that trapped or timed out: its store is gone
    /// and every further call on it returns [`HostError::DeadInstance`].
    instances: SlotMap<InstKey, Option<InstanceData>>,
    kv: Arc<Mutex<KvBackend>>,
    clock: HostClock,
    limits: ModuleLimits,
}

fn key_to_id(k: InstKey) -> ModuleInstanceId {
    ModuleInstanceId(k.data().as_ffi())
}
fn id_to_key(id: ModuleInstanceId) -> InstKey {
    InstKey::from(slotmap::KeyData::from_ffi(id.0))
}

impl WasmtimeHostAsync {
    /// Create a host with the default [`ModuleLimits`].
    pub fn new() -> Result<Self, HostError> {
        Self::with_limits(ModuleLimits::default())
    }

    /// Create a host with explicit resource limits (enforced the same way as
    /// the v0.1 host).
    pub fn with_limits(limits: ModuleLimits) -> Result<Self, HostError> {
        Self::with_options(limits, super::ExecStrategy::default())
    }

    /// Create a host with explicit limits and execution strategy
    /// ([`ExecStrategy::Interpreter`](super::ExecStrategy) = Pulley, for
    /// JIT-forbidden platforms; CM-async is backend-agnostic).
    pub fn with_options(
        limits: ModuleLimits,
        strategy: super::ExecStrategy,
    ) -> Result<Self, HostError> {
        let storage = Arc::new(Mutex::new(KvBackend::default()));
        Ok(Self::with_core(limits, HostCore::new(strategy)?, storage))
    }

    /// Create a host on an existing [`HostCore`] (engine + ticker + runtime)
    /// and storage backend, so [`super::DualHost`] runs both ABIs on one of
    /// each.
    pub(crate) fn with_core(
        limits: ModuleLimits,
        core: Arc<HostCore>,
        storage: Arc<Mutex<KvBackend>>,
    ) -> Self {
        Self {
            core,
            modules: HashMap::new(),
            instances: SlotMap::with_key(),
            kv: storage,
            clock: HostClock::real(),
            limits,
        }
    }

    /// Back `local`/`app` storage with a JSON snapshot file at `path`,
    /// loading anything a previous process persisted there (an unreadable or
    /// other-format file is an error; it is never overwritten). Changes are
    /// flushed at the end of each module call. Call before instantiating
    /// modules. `cloud` stays in-memory (sync-service sim).
    pub fn set_storage_path(&mut self, path: impl Into<std::path::PathBuf>) -> Result<(), HostError> {
        let backend =
            KvBackend::file_backed(path.into()).map_err(|e| HostError::Runtime(e.to_string()))?;
        *self.kv.lock().unwrap() = backend;
        Ok(())
    }

    /// Swap in a deterministic clock starting at `start_ms`. Returns the
    /// counter so callers can advance or inspect it; existing instances
    /// keep the clock they were created with.
    pub fn set_virtual_clock(&mut self, start_ms: u64) -> Arc<AtomicU64> {
        let counter = Arc::new(AtomicU64::new(start_ms));
        self.clock = HostClock::Virtual(Arc::clone(&counter));
        counter
    }

    fn build_linker(&self, manifest: &ModuleManifest) -> Result<Linker<HostState>, HostError> {
        let mut linker: Linker<HostState> = Linker::new(&self.core.engine);
        // p2 WASI coexists with CM-async imports in one linker: wasip2-built
        // guests still import wasi:io / wasi:cli @0.2.x. The async variant
        // suspends blocking operations (`poll`, blocking streams) back to
        // the host's runtime, where the call timeout can cancel them.
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // Same link-time capability denial as the v0.1 host.
        hypen::storage::local::add_to_linker::<HostState, HostCap>(&mut linker, |s| s)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;
        if manifest.grants_storage(StorageScope::App) {
            hypen::storage::app::add_to_linker::<HostState, HostCap>(&mut linker, |s| s)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }
        if manifest.grants_storage(StorageScope::Cloud) {
            hypen::storage::cloud::add_to_linker::<HostState, HostCap>(&mut linker, |s| s)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }

        hypen::engine::state::add_to_linker::<HostState, HostCap>(&mut linker, |s| s)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // hypen:time — implicitly granted (virtualizable, not deniable).
        hypen::time::clock::add_to_linker::<HostState, HostCap>(&mut linker, |s| s)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // `wasi:http` for async modules, same manifest gate as the v0.1
        // host. The p2 surface coexists with CM-async imports in one linker:
        // an async Rust module blocks its task on the p2 poll while fetching
        // (suspending to the host's runtime), which is the
        // constrained-data-access shape until wasi:http p3 stabilizes.
        if manifest.grants_http() {
            wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }
        Ok(linker)
    }

    fn fresh_store(&self, module: &str) -> Store<HostState> {
        let mut store = Store::new(
            &self.core.engine,
            HostState {
                table: ResourceTable::new(),
                limiter: TotalMemoryLimiter::new(self.limits.max_memory_bytes),
                wasi: WasiCtxBuilder::new().build(),
                http: WasiHttpCtx::new(),
                kv: Arc::clone(&self.kv),
                quota: self.limits.kv_quota(),
                module: module.to_string(),
                clock: self.clock.clone(),
                cross: CrossModuleCtx::default(),
            },
        );
        store.limiter(|s| &mut s.limiter);
        store.set_epoch_deadline(self.limits.deadline_ticks());
        store
    }

    /// Shared tail of every export call: flush storage the call wrote and,
    /// if it trapped or timed out, kill the instance (drop its store) so
    /// later calls get [`HostError::DeadInstance`].
    fn finish<R>(
        &mut self,
        id: ModuleInstanceId,
        result: Result<wasmtime::Result<wasmtime::Result<R>>, super::wasmtime_host::DeadlineExceeded>,
    ) -> Result<R, HostError> {
        self.kv.lock().unwrap().flush();
        let failure = match result {
            Ok(Ok(Ok(value))) => return Ok(value),
            Ok(Ok(Err(trap))) | Ok(Err(trap)) => trap.to_string(),
            Err(deadline) => deadline.to_string(),
        };
        if let Some(slot) = self.instances.get_mut(id_to_key(id)) {
            *slot = None;
        }
        Err(HostError::Trap(failure))
    }

    /// Install the per-call cross-module context from the instance's
    /// manifest, mirroring the v0.1 host.
    fn install_call_context(&mut self, id: ModuleInstanceId, siblings: &[SiblingState]) -> Result<(), HostError> {
        let inst = self
            .instances
            .get_mut(id_to_key(id))
            .and_then(Option::as_mut)
            .ok_or(HostError::DeadInstance)?;
        let manifest = &self
            .modules
            .get(&inst.type_name)
            .ok_or_else(|| HostError::UnknownModule(inst.type_name.clone()))?
            .manifest;
        inst.store.data_mut().cross.install(manifest, siblings);
        Ok(())
    }

    /// Clear the per-call context and, on success, drain the queued
    /// cross-module requests into the output.
    fn finish_with_siblings(
        &mut self,
        id: ModuleInstanceId,
        result: Result<Result<hypen::module::types::ReducerOutput, String>, HostError>,
    ) -> Result<super::ReducerOutput, HostError> {
        // The instance is gone if the call killed it.
        let Some(Some(inst)) = self.instances.get_mut(id_to_key(id)) else {
            return Err(result.err().unwrap_or(HostError::DeadInstance));
        };
        let cross = &mut inst.store.data_mut().cross;
        match result.and_then(|r| r.map_err(HostError::ModuleError)) {
            Ok(out) => {
                let mut output = from_wit_output(out);
                cross.drain_into(&mut output);
                Ok(output)
            }
            Err(e) => {
                cross.clear();
                Err(e)
            }
        }
    }
}

/// Drive one concurrent export call to completion on instance `$id`.
///
/// `run_concurrent` runs the store's component event loop while polling the
/// closure, all on the host's runtime under the per-call deadline: epoch
/// interruption traps guest code still running at the deadline, and the
/// timeout cancels a call whose guest task is parked in a host call.
/// Evaluates to `Result<R, HostError>`; a trap or timeout kills the instance.
macro_rules! drive {
    ($host:expr, $id:expr, |$acc:ident, $bindings:ident| $call:expr) => {{
        let host: &mut WasmtimeHostAsync = $host;
        let id: ModuleInstanceId = $id;
        let budget = host.limits.max_call;
        let ticks = host.limits.deadline_ticks();
        match host.instances.get_mut(id_to_key(id)).and_then(Option::as_mut) {
            None => Err(HostError::DeadInstance),
            Some(inst) => {
                inst.store.set_epoch_deadline(ticks);
                // Split borrows: the store is pumped mutably while the
                // closure only reads the bindings.
                let $bindings = &inst.bindings;
                let store = &mut inst.store;
                let result = host
                    .core
                    .run(budget, store.run_concurrent(async |$acc| $call.await));
                host.finish(id, result)
            }
        }
    }};
}

impl ModuleHost for WasmtimeHostAsync {
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        let component = Component::from_binary(&self.core.engine, component_bytes)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;
        let linker = self.build_linker(&manifest)?;
        self.modules
            .insert(name.to_string(), RegisteredModule { component, linker, manifest });
        Ok(())
    }

    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        let reg = self
            .modules
            .get(name)
            .ok_or_else(|| HostError::UnknownModule(name.to_string()))?;
        let mut store = self.fresh_store(name);
        // CM-async imports make the store async-required, so instantiation
        // goes through the async entrypoint — under the same deadline as an
        // export call, since component start runs guest code.
        let started = self.core.run(
            self.limits.max_call,
            ModuleX::instantiate_async(&mut store, &reg.component, &reg.linker),
        );
        // Persist anything the component's start wrote, even if it failed.
        self.kv.lock().unwrap().flush();
        let bindings = started
            .map_err(|deadline| HostError::Instantiate(deadline.to_string()))?
            .map_err(|e| HostError::Instantiate(e.to_string()))?;
        let key = self.instances.insert(Some(InstanceData {
            store,
            bindings,
            type_name: name.to_string(),
        }));
        Ok(key_to_id(key))
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        // A dead (trapped / timed-out) instance still occupies its slot until
        // destroyed, so destroying it succeeds.
        self.instances
            .remove(id_to_key(id))
            .ok_or(HostError::DeadInstance)?;
        Ok(())
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        let config = config.to_vec();
        drive!(self, id, |acc, bindings| bindings.call_init(acc, config))?
            .map_err(HostError::ModuleError)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        self.install_call_context(id, siblings)?;
        let state = state.to_vec();
        let wit_action = ActionWit { name: action.name, payload: action.payload };
        let result = drive!(self, id, |acc, bindings| bindings.call_dispatch(acc, state, wit_action));
        self.finish_with_siblings(id, result)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        self.install_call_context(id, siblings)?;
        let state = state.to_vec();
        let result = drive!(self, id, |acc, bindings| bindings.call_on_activated(acc, state));
        self.finish_with_siblings(id, result)
    }

    fn on_deactivated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<super::ReducerOutput, HostError> {
        let state = state.to_vec();
        let out = drive!(self, id, |acc, bindings| bindings.call_on_deactivated(acc, state))?
            .map_err(HostError::ModuleError)?;
        Ok(from_wit_output(out))
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        let state = state.to_vec();
        drive!(self, id, |acc, bindings| bindings.call_on_destroyed(acc, state))?
            .map_err(HostError::ModuleError)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        // `actions` is sync in the WIT but lifted onto the concurrent path
        // (`exports: { "actions": async | store }`) because the store is
        // async-required once CM-async imports are linked.
        drive!(self, id, |acc, bindings| bindings.call_actions(acc))
    }
}
