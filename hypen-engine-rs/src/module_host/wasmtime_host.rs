//! Native [`ModuleHost`] backed by wasmtime's component runtime.
//!
//! Loads `hypen:module` components, drives their reducer + lifecycle exports,
//! and provides the `hypen:storage/*` capability imports. Storage scopes are
//! linked *selectively* from each module's manifest, so a module importing a
//! scope it wasn't granted fails to instantiate — link-time capability denial.
//!
//! ## Sandbox
//!
//! Every guest entry (component start, `init`, `dispatch`, the lifecycle
//! hooks, `actions`) is an **async** wasmtime call driven by a current-thread
//! tokio runtime the host owns ([`HostCore`]), under two deadlines that both
//! measure wall-clock from the start of the call:
//!
//! - **epoch interruption** traps guest code that is still *running* at the
//!   deadline (CPU loops), and
//! - **`tokio::time::timeout`** cancels a call that is *parked in a host
//!   call* at the deadline — `wasi:io/poll`, a blocking stream read, a
//!   `wasi:http` request to a server that never answers. Those never return
//!   to guest code, so epochs alone would not fire.
//!
//! After a trap or a timeout the instance's store is discarded and the
//! instance is **dead**: further calls return [`HostError::DeadInstance`].
//!
//! Memory is bounded by a per-instance budget over *all* linear memories and
//! tables ([`TotalMemoryLimiter`]); storage by per-value and per-scope byte
//! quotas (see [`ModuleLimits`]).
//!
//! The [`ModuleHost`] surface stays synchronous: each method blocks on the
//! host's runtime. Do not call it from inside another tokio runtime's async
//! context (tokio refuses nested `block_on`); use `spawn_blocking` there.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use slotmap::{new_key_type, SlotMap};

new_key_type! {
    /// Internal key for `WasmtimeHost`'s instance slotmap. Mapped to/from
    /// the public opaque [`ModuleInstanceId`] via `Key::data().as_ffi()`.
    struct InstKey;
}
use wasmtime::component::{Component, HasSelf, Linker, Resource, ResourceTable};
use wasmtime::{Config, Engine as WtEngine, ResourceLimiter, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};
use wasmtime_wasi_http::WasiHttpCtx;

// NB: `ReducerOutput` is intentionally *not* imported here — the bindgen!
// macro emits a module-scope `ReducerOutput` (the WIT world type) that would
// shadow it. The engine-facing type is referred to as `super::ReducerOutput`.
use super::{
    Effect, HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleManifest, SiblingState,
    StorageScope,
};

// World `module-x` is a superset of `module` (adds hypen:engine/state). A
// linker built for it can still instantiate plain `module` components — the
// extra import is simply unused — so the host targets the superset.
wasmtime::component::bindgen!({
    path: "../wit",
    world: "module-x",
    // NB: resource keys use the 46-era `<iface>.<resource>` form (dot before
    // the resource name); wasmtime ≤37 accepted `<iface>/<resource>` and 46
    // rejects it as an unused `with` key. See wit/WASMTIME_46_MIGRATION.md.
    with: {
        "hypen:storage/local.bucket": BucketData,
        "hypen:storage/app.bucket": BucketData,
        "hypen:storage/cloud.bucket": BucketData,
        "hypen:storage/local.blob-handle": BlobHandleData,
        "hypen:storage/app.blob-handle": BlobHandleData,
        "hypen:storage/cloud.blob-handle": BlobHandleData,
        "hypen:storage/local.blob-writer": BlobWriterData,
        "hypen:storage/app.blob-writer": BlobWriterData,
        "hypen:storage/cloud.blob-writer": BlobWriterData,
        "hypen:storage/local.blob-bucket": BlobBucketData,
        "hypen:storage/app.blob-bucket": BlobBucketData,
        "hypen:storage/cloud.blob-bucket": BlobBucketData,
    },
    // Exports are called through `call_async` so a guest parked in an async
    // WASI host call suspends back to the host's runtime, where the per-call
    // timeout can cancel it. (The hypen:* imports below stay plain sync
    // functions: they never block.)
    exports: { default: async },
});

use hypen::storage::types::{EntryInfo, Error as StorageError, Tier};

use super::kv::{entry_key, KvBackend, KvQuota, KvScope, KvWriteError, PartitionId};

// ── limits ──────────────────────────────────────────────────────────────────

/// How often the background thread advances wasmtime's epoch counter. The
/// per-call wall-clock budget is expressed as a whole number of these ticks,
/// so this is also the granularity of the epoch (guest-CPU) timeout.
const EPOCH_TICK: Duration = Duration::from_millis(10);

/// Most cross-module requests (`hypen:engine/state.dispatch` and, counted
/// separately, `.subscribe`) one guest call may queue. Further requests fail
/// with an error instead of growing host memory.
pub(crate) const MAX_CROSS_MODULE_REQUESTS: usize = 256;
/// Largest single cross-module request (names + payload), in bytes.
pub(crate) const MAX_CROSS_MODULE_REQUEST_BYTES: usize = 1024 * 1024;

/// Resource limits applied to **every** module instance, guarding the host
/// against runaway or resource-hungry modules — the safety floor for running
/// untrusted / third-party `.wasm`.
///
/// - **memory**: a per-instance budget over the sum of *all* the instance's
///   linear memories and tables (growth past it is denied, so a module can't
///   exhaust host RAM however many memories its component declares),
/// - **time**: a wall-clock budget per export call (`init` / `dispatch` / a
///   lifecycle hook / `actions`, and component start) that covers both guest
///   code (epoch interruption) and time parked in host calls (timeout),
/// - **storage**: a per-value cap and a per-scope byte budget on
///   `hypen:storage` writes (over-budget writes get `quota-exceeded`).
///
/// Construct with `ModuleLimits { .., ..Default::default() }` so new limits
/// pick up their defaults.
#[derive(Clone, Copy, Debug)]
pub struct ModuleLimits {
    /// Max total linear memory (plus table storage) per instance, in bytes,
    /// summed over every memory in the component. Default: 256 MiB.
    pub max_memory_bytes: usize,
    /// Wall-clock budget for a single export call. Default: 5 s. Generous
    /// enough for a heavy JS (StarlingMonkey) dispatch, small enough that an
    /// infinite loop or a stalled host call can't hang the host indefinitely.
    pub max_call: Duration,
    /// Largest single `hypen:storage` value, in bytes. Default: 1 MiB (the
    /// WIT tells modules to keep KV values under that and use blobs beyond).
    pub max_storage_value_bytes: usize,
    /// Byte budget (keys + values) for each storage scope: per module for
    /// `local`, for the whole shared keyspace for `app` and for `cloud`.
    /// Default: 5 MiB.
    pub max_storage_bytes: usize,
}

impl Default for ModuleLimits {
    fn default() -> Self {
        Self {
            max_memory_bytes: 256 * 1024 * 1024,
            max_call: Duration::from_secs(5),
            max_storage_value_bytes: 1024 * 1024,
            max_storage_bytes: 5 * 1024 * 1024,
        }
    }
}

impl ModuleLimits {
    /// Number of epoch ticks that make up one `max_call` budget (≥ 1).
    pub(crate) fn deadline_ticks(&self) -> u64 {
        let ticks = self.max_call.as_millis() / EPOCH_TICK.as_millis().max(1);
        (ticks as u64).max(1)
    }

    pub(crate) fn kv_quota(&self) -> KvQuota {
        KvQuota {
            max_value_bytes: self.max_storage_value_bytes as u64,
            max_partition_bytes: self.max_storage_bytes as u64,
        }
    }
}

/// Per-store [`ResourceLimiter`] enforcing one **total** byte budget.
///
/// wasmtime's stock `StoreLimits::memory_size` caps each linear memory
/// separately (with up to 10 000 memories per store by default), so a
/// multi-memory component could hold many times the cap. This limiter is
/// consulted for every memory and table creation and growth in the store
/// (shared memories, which bypass limiters, are disabled in the engine
/// config) and charges each delta against a single budget.
///
/// Accounting is conservative: a growth that was approved here but then
/// failed in the runtime stays charged.
pub(crate) struct TotalMemoryLimiter {
    budget: usize,
    used: usize,
}

impl TotalMemoryLimiter {
    pub(crate) fn new(budget: usize) -> Self {
        Self { budget, used: 0 }
    }

    fn charge(&mut self, bytes: usize) -> bool {
        match self.used.checked_add(bytes) {
            Some(next) if next <= self.budget => {
                self.used = next;
                true
            }
            _ => false,
        }
    }
}

impl ResourceLimiter for TotalMemoryLimiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(self.charge(desired.saturating_sub(current)))
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // Each table element is a pointer-sized slot on the host.
        let elements = desired.saturating_sub(current);
        Ok(match elements.checked_mul(std::mem::size_of::<usize>()) {
            Some(bytes) => self.charge(bytes),
            None => false,
        })
    }
}

// ── shared runtime core ─────────────────────────────────────────────────────

/// A guest call outlived its wall-clock budget while parked in a host call.
#[derive(Debug)]
pub(crate) struct DeadlineExceeded(Duration);

impl std::fmt::Display for DeadlineExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "call exceeded its {} ms wall-clock budget while blocked in a host call",
            self.0.as_millis()
        )
    }
}

/// What the native hosts share: the wasmtime engine, the epoch-ticker thread
/// that drives guest-CPU timeouts, and the current-thread tokio runtime that
/// drives async guest calls. One per standalone host; [`super::DualHost`]
/// shares a single core between its v0.1 and v0.2 hosts (one engine, one
/// ticker thread, one runtime). Dropping the last reference stops the ticker.
pub(crate) struct HostCore {
    pub(crate) engine: WtEngine,
    /// `Some` until drop.
    runtime: Option<tokio::runtime::Runtime>,
    epoch_stop: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl HostCore {
    pub(crate) fn new(strategy: ExecStrategy) -> Result<Arc<Self>, HostError> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        // CM-async (the v0.2 world) is default-enabled with wasmtime's
        // `component-model-async` cargo feature; set explicitly for
        // self-documentation. v0.1 components don't use it.
        config.wasm_component_model_async(true);
        // Epoch interruption is the guest-CPU timeout: a background thread
        // ticks the epoch and guest code still running at its deadline traps.
        config.epoch_interruption(true);
        // Shared memories are not routed through `ResourceLimiter`; keep them
        // uncreatable (wasmtime's default) so the memory budget is total.
        config.shared_memory(false);
        if strategy == ExecStrategy::Interpreter {
            config
                .target(pulley_triple())
                .map_err(|e| HostError::Runtime(format!("pulley target: {e}")))?;
        }
        let engine = WtEngine::new(&config).map_err(|e| HostError::Runtime(e.to_string()))?;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| HostError::Runtime(format!("module runtime: {e}")))?;

        // Spawn the epoch ticker. Cloning the engine is cheap (Arc inside) and
        // lets the thread advance the shared epoch without touching the host.
        let epoch_stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let stop = Arc::clone(&epoch_stop);
            std::thread::Builder::new()
                .name("hypen-module-epoch".into())
                .spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(EPOCH_TICK);
                        engine.increment_epoch();
                    }
                })
                .map_err(|e| HostError::Runtime(format!("epoch ticker: {e}")))?
        };

        Ok(Arc::new(Self {
            engine,
            runtime: Some(runtime),
            epoch_stop,
            ticker: Some(ticker),
        }))
    }

    /// Drive one guest call to completion, or cancel it (by dropping the
    /// future, which unwinds the suspended guest) once `budget` has elapsed.
    /// The caller must treat the store as unusable after `Err`.
    pub(crate) fn run<F: Future>(&self, budget: Duration, call: F) -> Result<F::Output, DeadlineExceeded> {
        let runtime = self.runtime.as_ref().expect("runtime lives until drop");
        runtime
            .block_on(async { tokio::time::timeout(budget, call).await })
            .map_err(|_| DeadlineExceeded(budget))
    }
}

impl Drop for HostCore {
    fn drop(&mut self) {
        self.epoch_stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
        // Don't wait on blocking-pool work a cancelled call left behind
        // (e.g. a DNS lookup): dropping a host must not hang.
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

// ── storage backend ─────────────────────────────────────────────────────────

/// Host type behind every `bucket` resource (all three scopes map here).
pub struct BucketData {
    /// Which partition of the backend this bucket addresses. Derived from the
    /// scope and the instance's *registered* module name — not guest input.
    partition: PartitionId,
    tier: Tier,
    namespace: String,
}
// Blob host types — present so the resources type-check; not yet exercised.
pub struct BlobHandleData;
pub struct BlobWriterData;
pub struct BlobBucketData;

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

/// Per-call cross-module context shared by both hosts' store data: installed
/// immediately before a `dispatch` / `on-activated` export runs, drained and
/// cleared immediately after. Outside such a call every set is empty, so the
/// `hypen:engine/state` imports deny everything.
#[derive(Default)]
pub(crate) struct CrossModuleCtx {
    /// Sibling snapshots available to `hypen:engine/state.read`.
    sibling_states: HashMap<String, Vec<u8>>,
    /// Modules this instance's manifest allows it to read.
    reads_allowed: HashSet<String>,
    /// Modules this instance's manifest allows it to dispatch to.
    dispatches_allowed: HashSet<String>,
    /// Sibling dispatches the running reducer requested; drained after.
    dispatch_queue: Vec<(String, HostAction)>,
    /// Cross-module subscriptions the running reducer requested; drained after.
    subscribe_queue: Vec<super::SubscribeRequest>,
}

/// Why a `hypen:engine/state` call was refused.
pub(crate) enum CrossModuleError {
    NotFound,
    /// Names the missing manifest grant.
    PermissionDenied(&'static str),
    /// A per-call bound was exceeded.
    Limit(String),
}

impl CrossModuleCtx {
    pub(crate) fn install(&mut self, manifest: &ModuleManifest, siblings: &[SiblingState]) {
        self.sibling_states = siblings.iter().cloned().collect();
        self.reads_allowed = manifest.reads.iter().cloned().collect();
        self.dispatches_allowed = manifest.dispatches.iter().cloned().collect();
        self.dispatch_queue.clear();
        self.subscribe_queue.clear();
    }

    /// Move the queued requests into `output` and clear the context so it
    /// can't leak into a later call.
    pub(crate) fn drain_into(&mut self, output: &mut super::ReducerOutput) {
        output.cross_dispatch = std::mem::take(&mut self.dispatch_queue);
        output.subscribe_requests = std::mem::take(&mut self.subscribe_queue);
        self.clear();
    }

    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn read(&self, module: &str) -> Result<Vec<u8>, CrossModuleError> {
        if !self.reads_allowed.contains(module) {
            return Err(CrossModuleError::PermissionDenied("reads"));
        }
        self.sibling_states
            .get(module)
            .cloned()
            .ok_or(CrossModuleError::NotFound)
    }

    pub(crate) fn dispatch(&mut self, module: String, action: HostAction) -> Result<(), CrossModuleError> {
        if !self.dispatches_allowed.contains(&module) {
            return Err(CrossModuleError::PermissionDenied("dispatches"));
        }
        check_request(
            "dispatch",
            self.dispatch_queue.len(),
            action.name.len().saturating_add(action.payload.len()),
        )?;
        self.dispatch_queue.push((module, action));
        Ok(())
    }

    pub(crate) fn subscribe(
        &mut self,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), CrossModuleError> {
        // Observing state is a read: gate on the same `reads` grant.
        if !self.reads_allowed.contains(&module) {
            return Err(CrossModuleError::PermissionDenied("reads"));
        }
        check_request(
            "subscribe",
            self.subscribe_queue.len(),
            path.len().saturating_add(on_change.len()),
        )?;
        self.subscribe_queue.push(super::SubscribeRequest {
            target: module,
            path,
            on_change,
        });
        Ok(())
    }
}

fn check_request(what: &str, queued: usize, bytes: usize) -> Result<(), CrossModuleError> {
    if bytes > MAX_CROSS_MODULE_REQUEST_BYTES {
        return Err(CrossModuleError::Limit(format!(
            "{what} request of {bytes} bytes exceeds the {MAX_CROSS_MODULE_REQUEST_BYTES}-byte limit"
        )));
    }
    if queued >= MAX_CROSS_MODULE_REQUESTS {
        return Err(CrossModuleError::Limit(format!(
            "too many {what} requests in one call (limit {MAX_CROSS_MODULE_REQUESTS})"
        )));
    }
    Ok(())
}

/// Per-store host state: the wasi ctx, the resource table, a handle to the
/// shared storage backend, the wasi:http ctx, and the cross-module context
/// for the *currently executing* call.
struct HostState {
    table: ResourceTable,
    /// Per-instance total-memory limiter (see [`ModuleLimits`]).
    limiter: TotalMemoryLimiter,
    wasi: WasiCtx,
    /// wasi:http config. Used by `wasmtime-wasi-http` to drive
    /// `wasi:http/outgoing-handler` calls modules make directly.
    http: WasiHttpCtx,
    kv: Arc<Mutex<KvBackend>>,
    quota: KvQuota,
    /// Registered name of the module this instance belongs to — the owner of
    /// its `local` storage partition.
    module: String,
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

// Cross-module state capability. ACLs enforced against the per-call
// allow-sets the host installs from the module's manifest.
impl hypen::engine::state::Host for HostState {
    fn read(&mut self, module: String) -> Result<Vec<u8>, hypen::engine::state::Error> {
        Ok(self.cross.read(&module)?)
    }

    fn dispatch(
        &mut self,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        let action = HostAction { name: action.name, payload: action.payload };
        Ok(self.cross.dispatch(module, action)?)
    }

    fn subscribe(
        &mut self,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), hypen::engine::state::Error> {
        Ok(self.cross.subscribe(module, path, on_change)?)
    }
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
}

macro_rules! impl_kv_bucket {
    ($iface:path, $scope:expr) => {
        impl $iface for HostState {
            fn open(&mut self, tier: Tier, namespace: String) -> Result<Resource<BucketData>, StorageError> {
                HostState::open(self, $scope, tier, namespace)
            }
            fn get(&mut self, s: Resource<BucketData>, key: String) -> Result<Option<Vec<u8>>, StorageError> {
                self.b_get(&s, &key)
            }
            fn set(&mut self, s: Resource<BucketData>, key: String, value: Vec<u8>) -> Result<(), StorageError> {
                self.b_set(&s, &key, value)
            }
            fn delete(&mut self, s: Resource<BucketData>, key: String) -> Result<bool, StorageError> {
                self.b_delete(&s, &key)
            }
            fn keys(&mut self, _s: Resource<BucketData>, _p: String, _l: u32) -> Result<Vec<String>, StorageError> {
                Ok(vec![])
            }
            fn info(&mut self, _s: Resource<BucketData>, _k: String) -> Result<Option<EntryInfo>, StorageError> {
                Ok(None)
            }
            fn clear(&mut self, _s: Resource<BucketData>) -> Result<(), StorageError> {
                Ok(())
            }
            fn drop(&mut self, rep: Resource<BucketData>) -> wasmtime::Result<()> {
                self.table.delete(rep)?;
                Ok(())
            }
        }
    };
}

impl_kv_bucket!(hypen::storage::local::HostBucket, KvScope::Local);
impl_kv_bucket!(hypen::storage::app::HostBucket, KvScope::App);

impl hypen::storage::cloud::HostBucket for HostState {
    fn open(&mut self, tier: Tier, namespace: String) -> Result<Resource<BucketData>, StorageError> {
        HostState::open(self, KvScope::Cloud, tier, namespace)
    }
    fn get(&mut self, s: Resource<BucketData>, key: String) -> Result<Option<Vec<u8>>, StorageError> {
        self.b_get(&s, &key)
    }
    fn set(&mut self, s: Resource<BucketData>, key: String, value: Vec<u8>) -> Result<(), StorageError> {
        self.b_set(&s, &key, value)
    }
    fn delete(&mut self, s: Resource<BucketData>, key: String) -> Result<bool, StorageError> {
        self.b_delete(&s, &key)
    }
    fn keys(&mut self, _s: Resource<BucketData>, _p: String, _l: u32) -> Result<Vec<String>, StorageError> {
        Ok(vec![])
    }
    fn info(&mut self, _s: Resource<BucketData>, _k: String) -> Result<Option<EntryInfo>, StorageError> {
        Ok(None)
    }
    fn compare_and_set(
        &mut self,
        s: Resource<BucketData>,
        key: String,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        self.b_compare_and_set(&s, &key, expected, value)
    }
    fn drop(&mut self, rep: Resource<BucketData>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

macro_rules! impl_blob {
    ($handle:path, $writer:path, $bucket:path) => {
        impl $handle for HostState {
            fn size(&mut self, _s: Resource<BlobHandleData>) -> u64 { 0 }
            fn read(&mut self, _s: Resource<BlobHandleData>, _o: u64, _l: u32) -> Result<Vec<u8>, StorageError> {
                Err(StorageError::Unavailable("blob unimplemented".into()))
            }
            fn drop(&mut self, rep: Resource<BlobHandleData>) -> wasmtime::Result<()> { self.table.delete(rep)?; Ok(()) }
        }
        impl $writer for HostState {
            fn write(&mut self, _s: Resource<BlobWriterData>, _c: Vec<u8>) -> Result<(), StorageError> {
                Err(StorageError::Unavailable("blob unimplemented".into()))
            }
            fn finish(&mut self, _s: Resource<BlobWriterData>) -> Result<EntryInfo, StorageError> {
                Err(StorageError::Unavailable("blob unimplemented".into()))
            }
            fn abort(&mut self, _s: Resource<BlobWriterData>) {}
            fn drop(&mut self, rep: Resource<BlobWriterData>) -> wasmtime::Result<()> { self.table.delete(rep)?; Ok(()) }
        }
        impl $bucket for HostState {
            fn open(&mut self, _t: Tier, _n: String) -> Result<Resource<BlobBucketData>, StorageError> {
                Err(StorageError::Unavailable("blob unimplemented".into()))
            }
            fn get(&mut self, _s: Resource<BlobBucketData>, _k: String) -> Result<Option<Resource<BlobHandleData>>, StorageError> {
                Ok(None)
            }
            fn put(&mut self, _s: Resource<BlobBucketData>, _k: String) -> Result<Resource<BlobWriterData>, StorageError> {
                Err(StorageError::Unavailable("blob unimplemented".into()))
            }
            fn delete(&mut self, _s: Resource<BlobBucketData>, _k: String) -> Result<bool, StorageError> { Ok(false) }
            fn keys(&mut self, _s: Resource<BlobBucketData>, _p: String, _l: u32) -> Result<Vec<String>, StorageError> { Ok(vec![]) }
            fn drop(&mut self, rep: Resource<BlobBucketData>) -> wasmtime::Result<()> { self.table.delete(rep)?; Ok(()) }
        }
    };
}

impl hypen::storage::local::Host for HostState {}
impl hypen::storage::app::Host for HostState {}
impl hypen::storage::cloud::Host for HostState {}

impl_blob!(
    hypen::storage::local::HostBlobHandle,
    hypen::storage::local::HostBlobWriter,
    hypen::storage::local::HostBlobBucket
);
impl_blob!(
    hypen::storage::app::HostBlobHandle,
    hypen::storage::app::HostBlobWriter,
    hypen::storage::app::HostBlobBucket
);
impl_blob!(
    hypen::storage::cloud::HostBlobHandle,
    hypen::storage::cloud::HostBlobWriter,
    hypen::storage::cloud::HostBlobBucket
);

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

fn from_wit_output(o: ReducerOutputWit) -> super::ReducerOutput {
    super::ReducerOutput {
        state: o.state,
        effects: o.effects.into_iter().map(from_wit_effect).collect(),
        emit: o
            .emit
            .into_iter()
            .map(|a| HostAction { name: a.name, payload: a.payload })
            .collect(),
        // Filled by the caller after draining the per-call dispatch /
        // subscribe queues.
        cross_dispatch: Vec::new(),
        subscribe_requests: Vec::new(),
    }
}

// Aliases to the bindgen-generated world types (kept local to avoid clashing
// with the engine-facing `super::*` types of the same conceptual name).
type ActionWit = hypen::module::types::Action;
type ReducerOutputWit = hypen::module::types::ReducerOutput;


// ── the host ────────────────────────────────────────────────────────────────

struct RegisteredModule {
    component: Component,
    linker: Linker<HostState>,
    manifest: ModuleManifest,
}

struct InstanceData {
    store: Store<HostState>,
    bindings: ModuleX,
    /// Registered module name — used to look up the manifest for per-call
    /// cross-module ACLs.
    type_name: String,
}

/// Native module host. One per engine; owns the registered module types and
/// the live instances.
pub struct WasmtimeHost {
    core: Arc<HostCore>,
    modules: HashMap<String, RegisteredModule>,
    /// `None` marks an instance that trapped or timed out: its store is gone
    /// and every further call on it returns [`HostError::DeadInstance`].
    instances: SlotMap<InstKey, Option<InstanceData>>,
    kv: Arc<Mutex<KvBackend>>,
    limits: ModuleLimits,
}

use slotmap::Key;
fn key_to_id(k: InstKey) -> ModuleInstanceId {
    ModuleInstanceId(k.data().as_ffi())
}
fn id_to_key(id: ModuleInstanceId) -> InstKey {
    InstKey::from(slotmap::KeyData::from_ffi(id.0))
}

/// How the wasmtime engine executes module code.
///
/// `Jit` (Cranelift) is the default everywhere runtime codegen is allowed.
/// `Interpreter` compiles modules to Pulley bytecode and interprets them —
/// no executable pages are ever mapped, which is the hard requirement on
/// iOS (no JIT entitlement) and the reason this knob exists. Reducers are
/// small and event-driven, so interpretation is an acceptable trade there.
/// Timeouts and memory limits work identically under both.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ExecStrategy {
    #[default]
    Jit,
    Interpreter,
}

/// The Pulley target triple for the current pointer width.
pub(crate) fn pulley_triple() -> &'static str {
    if cfg!(target_pointer_width = "32") {
        "pulley32"
    } else {
        "pulley64"
    }
}

impl WasmtimeHost {
    /// Create a host with the default [`ModuleLimits`].
    pub fn new() -> Result<Self, HostError> {
        Self::with_limits(ModuleLimits::default())
    }

    /// Create a host with explicit resource limits. Every instance this host
    /// creates is bounded by `limits`.
    pub fn with_limits(limits: ModuleLimits) -> Result<Self, HostError> {
        Self::with_options(limits, ExecStrategy::default())
    }

    /// Create a host with explicit limits and execution strategy
    /// ([`ExecStrategy::Interpreter`] for JIT-forbidden platforms — iOS).
    pub fn with_options(limits: ModuleLimits, strategy: ExecStrategy) -> Result<Self, HostError> {
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
            limits,
        }
    }

    /// Back `local`/`app` storage with a JSON snapshot file at `path`,
    /// loading anything a previous process persisted there (an unreadable or
    /// other-format file is an error; it is never overwritten). Changes are
    /// flushed at the end of each module call. Call before instantiating
    /// modules; existing in-memory contents are replaced. `cloud` stays
    /// in-memory (it simulates a sync service, not a disk).
    pub fn set_storage_path(&mut self, path: impl Into<std::path::PathBuf>) -> Result<(), HostError> {
        let backend =
            KvBackend::file_backed(path.into()).map_err(|e| HostError::Runtime(e.to_string()))?;
        *self.kv.lock().unwrap() = backend;
        Ok(())
    }

    fn build_linker(&self, manifest: &ModuleManifest) -> Result<Linker<HostState>, HostError> {
        let mut linker: Linker<HostState> = Linker::new(&self.core.engine);
        // Async WASI: blocking operations (`poll`, `pollable.block`, blocking
        // stream reads/writes) suspend the guest back to the host's runtime
        // instead of parking the host thread, so the call timeout covers them.
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // `local` is always granted. `app`/`cloud` only if the manifest says
        // so — an ungranted scope is simply absent from the linker, so a
        // module importing it fails to instantiate.
        hypen::storage::local::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;
        if manifest.grants_storage(StorageScope::App) {
            hypen::storage::app::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }
        if manifest.grants_storage(StorageScope::Cloud) {
            hypen::storage::cloud::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }

        // Cross-module state is always linked (harmless for modules that don't
        // import it); the per-target ACL is enforced at call time from the
        // manifest's `reads`/`dispatches`.
        hypen::engine::state::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // `wasi:http/outgoing-handler` — modules use this directly (via
        // their own wit-bindgen) for HTTP. Egress is a manifest grant
        // enforced at link time, exactly like storage — a module that
        // imports `wasi:http` without `"http": true` fails to instantiate.
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
                cross: CrossModuleCtx::default(),
            },
        );
        // Enforce the memory budget, and give instantiation (which runs the
        // component's start — heavy for JS engines) a fresh time budget.
        store.limiter(|s| &mut s.limiter);
        store.set_epoch_deadline(self.limits.deadline_ticks());
        store
    }

    /// Run one guest export on a live instance under the per-call deadline.
    ///
    /// Arms the epoch deadline (guest CPU) and wraps the call in the
    /// wall-clock timeout (host calls), flushes storage the call wrote, and
    /// — if the call trapped or timed out — kills the instance: its store is
    /// dropped and later calls get [`HostError::DeadInstance`].
    fn call<R>(
        &mut self,
        id: ModuleInstanceId,
        export: impl AsyncFnOnce(&ModuleX, &mut Store<HostState>) -> wasmtime::Result<R>,
    ) -> Result<R, HostError> {
        let slot = self
            .instances
            .get_mut(id_to_key(id))
            .ok_or(HostError::DeadInstance)?;
        let inst = slot.as_mut().ok_or(HostError::DeadInstance)?;
        inst.store.set_epoch_deadline(self.limits.deadline_ticks());

        let result = self
            .core
            .run(self.limits.max_call, export(&inst.bindings, &mut inst.store));
        self.kv.lock().unwrap().flush();

        let failure = match result {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(trap)) => trap.to_string(),
            Err(deadline) => deadline.to_string(),
        };
        *slot = None;
        Err(HostError::Trap(failure))
    }

    /// [`call`](Self::call) for the exports that may use `hypen:engine/state`:
    /// installs the cross-module context (ACLs from the manifest + sibling
    /// snapshots) for the duration of the call and drains the requests the
    /// guest queued into the output.
    fn call_with_siblings(
        &mut self,
        id: ModuleInstanceId,
        siblings: &[SiblingState],
        export: impl AsyncFnOnce(&ModuleX, &mut Store<HostState>) -> wasmtime::Result<Result<ReducerOutputWit, String>>,
    ) -> Result<super::ReducerOutput, HostError> {
        {
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
        }

        let result = self.call(id, export);

        // The instance is gone if the call killed it; otherwise always clear
        // the context, whether or not the reducer succeeded.
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

impl ModuleHost for WasmtimeHost {
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
        // Component start runs guest code (heavy for JS engines), so it gets
        // the same deadline as an export call.
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
        self.call(id, async |bindings, store| bindings.call_init(store, &config).await)?
            .map_err(HostError::ModuleError)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        let state = state.to_vec();
        let action = ActionWit { name: action.name, payload: action.payload };
        self.call_with_siblings(id, siblings, async |bindings, store| {
            bindings.call_dispatch(store, &state, &action).await
        })
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        // Same cross-module context as `dispatch`, so a hook that reads /
        // dispatches / subscribes from `on_activated` is gated identically.
        let state = state.to_vec();
        self.call_with_siblings(id, siblings, async |bindings, store| {
            bindings.call_on_activated(store, &state).await
        })
    }

    fn on_deactivated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<super::ReducerOutput, HostError> {
        let state = state.to_vec();
        let out = self
            .call(id, async |bindings, store| {
                bindings.call_on_deactivated(store, &state).await
            })?
            .map_err(HostError::ModuleError)?;
        Ok(from_wit_output(out))
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        let state = state.to_vec();
        self.call(id, async |bindings, store| {
            bindings.call_on_destroyed(store, &state).await
        })?
        .map_err(HostError::ModuleError)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        self.call(id, async |bindings, store| bindings.call_actions(store).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::{Instance, Module, Table};

    const PAGE: usize = 64 * 1024;

    /// The budget is a total across memories: a module with two linear
    /// memories can't hold more than the budget between them, however the
    /// growth is split — which a per-memory cap would allow.
    #[test]
    fn memory_budget_is_summed_across_linear_memories() {
        let engine = WtEngine::default();
        let mut store = Store::new(&engine, TotalMemoryLimiter::new(4 * PAGE));
        store.limiter(|limiter| limiter);
        let module = Module::new(
            &engine,
            r#"(module (memory (export "a") 1) (memory (export "b") 1))"#,
        )
        .unwrap();
        let instance = Instance::new(&mut store, &module, &[]).unwrap();
        let a = instance.get_memory(&mut store, "a").unwrap();
        let b = instance.get_memory(&mut store, "b").unwrap();

        // 2 pages used at instantiation; 2 more fit, in any split.
        a.grow(&mut store, 1).unwrap();
        b.grow(&mut store, 1).unwrap();
        assert!(a.grow(&mut store, 1).is_err(), "a: over the total budget");
        assert!(b.grow(&mut store, 1).is_err(), "b: over the total budget");
        assert_eq!(a.size(&store) + b.size(&store), 4);

        // A second instance in the same store draws on the same budget.
        assert!(Instance::new(&mut store, &module, &[]).is_err());
    }

    /// Initial memories count too: a component can't dodge the budget by
    /// declaring many memories that never grow.
    #[test]
    fn memory_budget_covers_initial_sizes() {
        let engine = WtEngine::default();
        let mut store = Store::new(&engine, TotalMemoryLimiter::new(3 * PAGE));
        store.limiter(|limiter| limiter);
        let module = Module::new(&engine, r#"(module (memory 2) (memory 2))"#).unwrap();
        assert!(Instance::new(&mut store, &module, &[]).is_err());
    }

    /// Tables are charged against the same budget (a pointer per element).
    #[test]
    fn memory_budget_covers_tables() {
        let engine = WtEngine::default();
        let slot = std::mem::size_of::<usize>();
        let mut store = Store::new(&engine, TotalMemoryLimiter::new(PAGE + 10 * slot));
        store.limiter(|limiter| limiter);
        let module = Module::new(
            &engine,
            r#"(module (memory 1) (table (export "t") 4 funcref))"#,
        )
        .unwrap();
        let instance = Instance::new(&mut store, &module, &[]).unwrap();
        let table: Table = instance.get_table(&mut store, "t").unwrap();
        table.grow(&mut store, 6, wasmtime::Ref::Func(None)).unwrap();
        assert!(table.grow(&mut store, 1, wasmtime::Ref::Func(None)).is_err());
    }

    /// A host's background resources stop with it: after the last reference
    /// to the core drops, nothing keeps ticking the engine's epoch.
    #[test]
    fn dropping_the_core_stops_the_epoch_ticker() {
        let core = HostCore::new(ExecStrategy::Jit).unwrap();
        let stop = Arc::clone(&core.epoch_stop);
        let second = Arc::clone(&core);
        drop(core);
        assert!(!stop.load(Ordering::Relaxed), "still referenced: keeps ticking");
        drop(second);
        assert!(stop.load(Ordering::Relaxed));
        // `Drop` joined the thread; only our handle to the flag is left.
        assert_eq!(Arc::strong_count(&stop), 1);
    }

    /// The deadline wrapper cancels a future that never completes.
    #[test]
    fn run_cancels_at_the_deadline() {
        let core = HostCore::new(ExecStrategy::Jit).unwrap();
        let started = std::time::Instant::now();
        let res = core.run(Duration::from_millis(50), std::future::pending::<()>());
        assert!(res.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(core.run(Duration::from_secs(5), async { 7 }).unwrap(), 7);
    }
}
