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
//! - No tokio: the host's storage/state impls resolve without real I/O, so
//!   `futures_executor::block_on` is sufficient to drive the loop. (Linking
//!   tokio-backed imports — e.g. wasi:http p3 — will need an ambient
//!   runtime; that lands with p3 HTTP support, which is still
//!   experimental/semver-exempt in wasmtime 46.)
//! - wasi:http is intentionally NOT linked here yet: v0.2 modules are
//!   expected to use `wasi:http/client@0.3.0` once `wasmtime-wasi-http`'s
//!   p3 surface stabilizes.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use slotmap::{new_key_type, Key, SlotMap};

new_key_type! {
    struct InstKey;
}

use wasmtime::component::{
    Accessor, Component, HasData, Linker, Resource, ResourceTable, StreamReader,
};
use wasmtime::{Config, Engine as WtEngine, Store, StoreLimits, StoreLimitsBuilder};
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

// ── storage backend (same in-memory model as the sync host) ────────────────

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Scope {
    Local,
    App,
    Cloud,
}

/// Host type behind every `bucket` resource (all three scopes map here).
pub struct BucketData {
    scope: Scope,
    tier: Tier,
    namespace: String,
}
/// Blob host type — blobs are stubbed until the stream plumbing matures
/// (`stream<u8>` signatures pass through bindgen; impls return
/// `unavailable`).
pub struct BlobBucketData;

use super::kv::{CloudEntry, KvBackend};

fn composite(b: &BucketData, key: &str) -> String {
    format!("{:?}/{:?}/{}/{}", b.scope, b.tier, b.namespace, key)
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

/// How often the background thread advances wasmtime's epoch counter.
const EPOCH_TICK: Duration = Duration::from_millis(10);

pub use super::wasmtime_host::ModuleLimits;

struct HostState {
    table: ResourceTable,
    limits: StoreLimits,
    wasi: WasiCtx,
    /// wasi:http config, used only when the manifest grants egress.
    http: WasiHttpCtx,
    kv: Arc<Mutex<KvBackend>>,
    clock: HostClock,
    /// Cap on one `sleep-ms`, set from the per-call wall-clock budget: the
    /// epoch deadline would trap the reducer right after a longer sleep
    /// anyway, so there is no point blocking the host thread past it.
    max_sleep: Duration,

    // Per-call cross-module context (installed before each dispatch /
    // on-activated, drained + cleared after), same model as the sync host.
    sibling_states: HashMap<String, Vec<u8>>,
    reads_allowed: HashSet<String>,
    dispatches_allowed: HashSet<String>,
    xdispatch_queue: Vec<(String, HostAction)>,
    subscribe_queue: Vec<super::SubscribeRequest>,
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
    fn open(&mut self, scope: Scope, tier: Tier, namespace: String) -> Resource<BucketData> {
        self.table
            .push(BucketData { scope, tier, namespace })
            .expect("resource table push")
    }
    fn b_get(&mut self, res: &Resource<BucketData>, key: &str) -> Option<Vec<u8>> {
        let b = self.table.get(res).expect("live bucket");
        let ck = composite(b, key);
        let kv = self.kv.lock().unwrap();
        match b.scope {
            Scope::Cloud => kv.cloud.get(&ck).map(|e| e.value.clone()),
            _ => kv.plain.get(&ck).cloned(),
        }
    }
    fn b_set(&mut self, res: &Resource<BucketData>, key: &str, value: Vec<u8>) {
        let b = self.table.get(res).expect("live bucket");
        let ck = composite(b, key);
        let mut kv = self.kv.lock().unwrap();
        match b.scope {
            Scope::Cloud => {
                let next = kv.cloud.get(&ck).map(|e| e.version + 1).unwrap_or(1);
                kv.cloud.insert(ck, CloudEntry { value, version: next });
            }
            _ => {
                kv.plain.insert(ck, value);
                kv.flush_plain();
            }
        }
    }
    fn b_delete(&mut self, res: &Resource<BucketData>, key: &str) -> bool {
        let b = self.table.get(res).expect("live bucket");
        let ck = composite(b, key);
        let mut kv = self.kv.lock().unwrap();
        match b.scope {
            Scope::Cloud => kv.cloud.remove(&ck).is_some(),
            _ => {
                let removed = kv.plain.remove(&ck).is_some();
                if removed {
                    kv.flush_plain();
                }
                removed
            }
        }
    }
    fn b_info(&mut self, res: &Resource<BucketData>, key: &str) -> Option<EntryInfo> {
        let b = self.table.get(res).expect("live bucket");
        let ck = composite(b, key);
        let kv = self.kv.lock().unwrap();
        match b.scope {
            Scope::Cloud => kv.cloud.get(&ck).map(|e| EntryInfo {
                size: e.value.len() as u64,
                modified_ms: 0,
                version: Some(e.version),
            }),
            _ => kv.plain.get(&ck).map(|v| EntryInfo {
                size: v.len() as u64,
                modified_ms: 0,
                version: None,
            }),
        }
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
                    Ok(accessor.with(|mut a| a.get().open($scope, tier, namespace)))
                }
                async fn get(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                ) -> Result<Option<Vec<u8>>, StorageError> {
                    Ok(accessor.with(|mut a| a.get().b_get(&s, &key)))
                }
                async fn set(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                    value: Vec<u8>,
                ) -> Result<(), StorageError> {
                    accessor.with(|mut a| a.get().b_set(&s, &key, value));
                    Ok(())
                }
                async fn delete(
                    accessor: &Accessor<HostState, Self>,
                    s: Resource<BucketData>,
                    key: String,
                ) -> Result<bool, StorageError> {
                    Ok(accessor.with(|mut a| a.get().b_delete(&s, &key)))
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
                    Ok(accessor.with(|mut a| a.get().b_info(&s, &key)))
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

impl_async_kv_bucket!(hypen::storage::local, Scope::Local);
impl_async_kv_bucket!(hypen::storage::app, Scope::App);
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
        Ok(accessor.with(|mut a| a.get().open(Scope::Cloud, tier, namespace)))
    }
    async fn get(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(accessor.with(|mut a| a.get().b_get(&s, &key)))
    }
    async fn set(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
        value: Vec<u8>,
    ) -> Result<(), StorageError> {
        accessor.with(|mut a| a.get().b_set(&s, &key, value));
        Ok(())
    }
    async fn delete(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
    ) -> Result<bool, StorageError> {
        Ok(accessor.with(|mut a| a.get().b_delete(&s, &key)))
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
        Ok(accessor.with(|mut a| a.get().b_info(&s, &key)))
    }
    async fn compare_and_set(
        accessor: &Accessor<HostState, Self>,
        s: Resource<BucketData>,
        key: String,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        accessor.with(|mut a| {
            let host = a.get();
            let b = host.table.get(&s).expect("live bucket");
            let ck = composite(b, &key);
            let mut kv = host.kv.lock().unwrap();
            let current = kv.cloud.get(&ck).map(|e| e.version);
            let matches = match (expected, current) {
                (None, None) => true,
                (Some(e), Some(c)) => e == c,
                _ => false,
            };
            if !matches {
                return Err(StorageError::Unavailable("version mismatch".into()));
            }
            let next = current.unwrap_or(0) + 1;
            kv.cloud.insert(ck, CloudEntry { value, version: next });
            Ok(next)
        })
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

// Cross-module state capability — async in v0.2, same call-time ACL model.
impl hypen::engine::state::HostWithStore<HostState> for HostCap {
    async fn read(
        accessor: &Accessor<HostState, Self>,
        module: String,
    ) -> Result<Vec<u8>, hypen::engine::state::Error> {
        accessor.with(|mut a| {
            let host = a.get();
            if !host.reads_allowed.contains(&module) {
                return Err(hypen::engine::state::Error::PermissionDenied("reads".into()));
            }
            host.sibling_states
                .get(&module)
                .cloned()
                .ok_or(hypen::engine::state::Error::NotFound)
        })
    }

    async fn dispatch(
        accessor: &Accessor<HostState, Self>,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        accessor.with(|mut a| {
            let host = a.get();
            if !host.dispatches_allowed.contains(&module) {
                return Err(hypen::engine::state::Error::PermissionDenied(
                    "dispatches".into(),
                ));
            }
            host.xdispatch_queue
                .push((module, HostAction { name: action.name, payload: action.payload }));
            Ok(())
        })
    }

    async fn subscribe(
        accessor: &Accessor<HostState, Self>,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), hypen::engine::state::Error> {
        accessor.with(|mut a| {
            let host = a.get();
            // Observing state is a read: gate on the same `reads` grant.
            if !host.reads_allowed.contains(&module) {
                return Err(hypen::engine::state::Error::PermissionDenied("reads".into()));
            }
            host.subscribe_queue.push(super::SubscribeRequest {
                target: module,
                path,
                on_change,
            });
            Ok(())
        })
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
        let (clock, cap) = accessor.with(|mut a| {
            let host = a.get();
            (host.clock.clone(), host.max_sleep)
        });
        match clock {
            HostClock::Virtual(c) => {
                c.fetch_add(ms, Ordering::Relaxed);
            }
            HostClock::Real { .. } => {
                // Blocking the executor thread is fine here: one guest call
                // is in flight per host call, and the sleep is capped by the
                // same budget the epoch deadline enforces.
                std::thread::sleep(Duration::from_millis(ms).min(cap));
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
/// completion.
pub struct WasmtimeHostAsync {
    engine: WtEngine,
    modules: HashMap<String, RegisteredModule>,
    instances: SlotMap<InstKey, InstanceData>,
    kv: Arc<Mutex<KvBackend>>,
    clock: HostClock,
    limits: ModuleLimits,
    epoch_stop: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl Drop for WasmtimeHostAsync {
    fn drop(&mut self) {
        self.epoch_stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
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

    /// Create a host with explicit resource limits (memory + per-call
    /// wall-clock, enforced the same two ways as the sync host).
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
        let mut config = Config::new();
        config.wasm_component_model(true);
        // CM-async is default-enabled with the `component-model-async`
        // cargo feature; set it explicitly for self-documentation.
        config.wasm_component_model_async(true);
        config.epoch_interruption(true);
        if strategy == super::ExecStrategy::Interpreter {
            config
                .target(super::wasmtime_host::pulley_triple())
                .map_err(|e| HostError::Runtime(format!("pulley target: {e}")))?;
        }
        let engine = WtEngine::new(&config).map_err(|e| HostError::Runtime(e.to_string()))?;

        let epoch_stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let stop = Arc::clone(&epoch_stop);
            std::thread::Builder::new()
                .name("hypen-module-epoch-async".into())
                .spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(EPOCH_TICK);
                        engine.increment_epoch();
                    }
                })
                .map_err(|e| HostError::Runtime(format!("epoch ticker: {e}")))?
        };

        Ok(Self {
            engine,
            modules: HashMap::new(),
            instances: SlotMap::with_key(),
            kv: Arc::new(Mutex::new(KvBackend::default())),
            clock: HostClock::real(),
            limits,
            epoch_stop,
            ticker: Some(ticker),
        })
    }

    /// Back `local`/`app` storage with a write-through JSON file at `path`,
    /// loading anything a previous process persisted there. Call before
    /// instantiating modules. `cloud` stays in-memory (sync-service sim).
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
        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        // p2 WASI coexists with CM-async imports in one linker: wasip2-built
        // guests still import wasi:io / wasi:cli @0.2.x.
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
            .map_err(|e| HostError::Instantiate(e.to_string()))?;

        // Same link-time capability denial as the sync host.
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

        // `wasi:http` for async modules, same manifest gate as the sync host.
        // The p2 sync surface coexists with CM-async imports in one linker
        // (the wrappers run the request on their own tokio runtime via
        // `in_tokio`, so no ambient runtime is required) — an async Rust
        // module blocks its task on the p2 poll while fetching, which is the
        // constrained-data-access shape until wasi:http p3 stabilizes.
        if manifest.grants_http() {
            wasmtime_wasi_http::p2::add_only_http_to_linker_sync(&mut linker)
                .map_err(|e| HostError::Instantiate(e.to_string()))?;
        }
        Ok(linker)
    }

    fn fresh_store(&self) -> Store<HostState> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(self.limits.max_memory_bytes)
            .build();
        let mut store = Store::new(
            &self.engine,
            HostState {
                table: ResourceTable::new(),
                limits,
                wasi: WasiCtxBuilder::new().build(),
                http: WasiHttpCtx::new(),
                kv: Arc::clone(&self.kv),
                clock: self.clock.clone(),
                max_sleep: self.limits.max_call,
                sibling_states: HashMap::new(),
                reads_allowed: HashSet::new(),
                dispatches_allowed: HashSet::new(),
                xdispatch_queue: Vec::new(),
                subscribe_queue: Vec::new(),
            },
        );
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(self.limits.deadline_ticks());
        store
    }

    fn inst(&mut self, id: ModuleInstanceId) -> Result<&mut InstanceData, HostError> {
        self.instances
            .get_mut(id_to_key(id))
            .ok_or(HostError::DeadInstance)
    }

    /// Look up an instance and arm its per-call timeout (fresh epoch budget).
    fn arm(&mut self, id: ModuleInstanceId) -> Result<&mut InstanceData, HostError> {
        let ticks = self.limits.deadline_ticks();
        let inst = self.inst(id)?;
        inst.store.set_epoch_deadline(ticks);
        Ok(inst)
    }

    /// Install the per-call cross-module context from the instance's
    /// manifest, mirroring the sync host.
    fn install_call_context(&mut self, id: ModuleInstanceId, siblings: &[SiblingState]) -> Result<(), HostError> {
        let type_name = self.inst(id)?.type_name.clone();
        let (reads_allowed, dispatches_allowed) = self
            .modules
            .get(&type_name)
            .map(|m| {
                (
                    m.manifest.reads.iter().cloned().collect::<HashSet<_>>(),
                    m.manifest.dispatches.iter().cloned().collect::<HashSet<_>>(),
                )
            })
            .unwrap_or_default();
        let inst = self.inst(id)?;
        let data = inst.store.data_mut();
        data.sibling_states = siblings.iter().cloned().collect();
        data.reads_allowed = reads_allowed;
        data.dispatches_allowed = dispatches_allowed;
        data.xdispatch_queue.clear();
        data.subscribe_queue.clear();
        Ok(())
    }

    /// Drain the per-call queues into `output` and clear the context.
    fn drain_call_context(&mut self, id: ModuleInstanceId, output: &mut super::ReducerOutput) -> Result<(), HostError> {
        let inst = self.inst(id)?;
        let data = inst.store.data_mut();
        output.cross_dispatch = std::mem::take(&mut data.xdispatch_queue);
        output.subscribe_requests = std::mem::take(&mut data.subscribe_queue);
        data.sibling_states.clear();
        data.reads_allowed.clear();
        data.dispatches_allowed.clear();
        Ok(())
    }
}

/// Drive one concurrent export call to completion on `inst`'s store.
///
/// `run_concurrent` runs the store's component event loop while polling the
/// closure; our capability impls resolve without real I/O, so a plain
/// `block_on` (no tokio) pumps everything, including the guest's suspension
/// points. Epoch-deadline traps surface as errors from the awaited call.
macro_rules! drive {
    ($inst:expr, |$acc:ident, $bindings:ident| $call:expr) => {{
        let inst: &mut InstanceData = $inst;
        // Split borrows: the store is pumped mutably while the closure only
        // reads the bindings.
        let $bindings = &inst.bindings;
        futures_executor::block_on(async {
            inst.store
                .run_concurrent(async |$acc| $call.await)
                .await
                .map_err(|e| HostError::Trap(e.to_string()))?
                .map_err(|e| HostError::Trap(e.to_string()))
        })
    }};
}

impl ModuleHost for WasmtimeHostAsync {
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        let component = Component::from_binary(&self.engine, component_bytes)
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
        let mut store = self.fresh_store();
        // CM-async imports make the store async-required, so instantiation
        // goes through the async entrypoint (still driven by block_on).
        let bindings = futures_executor::block_on(ModuleX::instantiate_async(
            &mut store,
            &reg.component,
            &reg.linker,
        ))
        .map_err(|e| HostError::Instantiate(e.to_string()))?;
        let key = self.instances.insert(InstanceData {
            store,
            bindings,
            type_name: name.to_string(),
        });
        Ok(key_to_id(key))
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        self.instances
            .remove(id_to_key(id))
            .ok_or(HostError::DeadInstance)?;
        Ok(())
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        let config = config.to_vec();
        let inst = self.arm(id)?;
        drive!(inst, |acc, bindings| bindings.call_init(acc, config.clone()))?
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
        let inst = self.arm(id)?;
        let out = drive!(inst, |acc, bindings| bindings.call_dispatch(
            acc,
            state.clone(),
            wit_action.clone()
        ))?
        .map_err(HostError::ModuleError)?;

        let mut output = from_wit_output(out);
        self.drain_call_context(id, &mut output)?;
        Ok(output)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        self.install_call_context(id, siblings)?;
        let state = state.to_vec();
        let inst = self.arm(id)?;
        let out = drive!(inst, |acc, bindings| bindings.call_on_activated(acc, state.clone()))?
            .map_err(HostError::ModuleError)?;

        let mut output = from_wit_output(out);
        self.drain_call_context(id, &mut output)?;
        Ok(output)
    }

    fn on_deactivated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<super::ReducerOutput, HostError> {
        let state = state.to_vec();
        let inst = self.arm(id)?;
        let out = drive!(inst, |acc, bindings| bindings.call_on_deactivated(acc, state.clone()))?
            .map_err(HostError::ModuleError)?;
        Ok(from_wit_output(out))
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        let state = state.to_vec();
        let inst = self.arm(id)?;
        drive!(inst, |acc, bindings| bindings.call_on_destroyed(acc, state.clone()))?
            .map_err(HostError::ModuleError)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        let inst = self.arm(id)?;
        // `actions` is sync in the WIT but lifted onto the concurrent path
        // (`exports: { "actions": async | store }`) because the store is
        // async-required once CM-async imports are linked.
        drive!(inst, |acc, bindings| bindings.call_actions(acc))
    }
}
