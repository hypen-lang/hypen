//! Native [`ModuleHost`] backed by wasmtime's component runtime.
//!
//! Loads `hypen:module` components, drives their reducer + lifecycle exports,
//! and provides the `hypen:storage/*` capability imports. Storage scopes are
//! linked *selectively* from each module's manifest, so a module importing a
//! scope it wasn't granted fails to instantiate — link-time capability denial.

use std::collections::{HashMap, HashSet};
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
use wasmtime::{Config, Engine as WtEngine, Store, StoreLimits, StoreLimitsBuilder};
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
});

use hypen::storage::types::{EntryInfo, Error as StorageError, Tier};

// ── storage backend ─────────────────────────────────────────────────────────

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
// Blob host types — present so the resources type-check; not yet exercised.
pub struct BlobHandleData;
pub struct BlobWriterData;
pub struct BlobBucketData;

use super::kv::{CloudEntry, KvBackend};

fn composite(b: &BucketData, key: &str) -> String {
    format!("{:?}/{:?}/{}/{}", b.scope, b.tier, b.namespace, key)
}

/// Per-store host state. Holds the wasi ctx, the resource table, a handle to
/// the shared storage backend, the wasi:http ctx, and the cross-module context
/// for the *currently executing* dispatch (set by the host immediately before
/// the `dispatch` export runs, read back immediately after).
/// How often the background thread advances wasmtime's epoch counter. The
/// per-call wall-clock budget is expressed as a whole number of these ticks,
/// so this is also the granularity of the timeout.
const EPOCH_TICK: Duration = Duration::from_millis(10);

/// Resource limits applied to **every** module instance, guarding the host
/// against runaway or memory-hungry modules — the safety floor for running
/// untrusted / third-party `.wasm`.
///
/// Enforced two ways:
/// - **memory** via a wasmtime `StoreLimits` limiter (growth past the cap is
///   denied, so a module can't exhaust host RAM),
/// - **time** via epoch interruption (a single export call — `init` /
///   `dispatch` / a lifecycle hook / `actions` — that runs longer than
///   `max_call` traps instead of hanging the host).
#[derive(Clone, Copy, Debug)]
pub struct ModuleLimits {
    /// Max linear memory per instance, in bytes. Default: 256 MiB.
    pub max_memory_bytes: usize,
    /// Wall-clock budget for a single export call. Default: 5 s. Generous
    /// enough for a heavy JS (StarlingMonkey) dispatch, small enough that an
    /// infinite loop can't hang the host indefinitely.
    pub max_call: Duration,
}

impl Default for ModuleLimits {
    fn default() -> Self {
        Self {
            max_memory_bytes: 256 * 1024 * 1024,
            max_call: Duration::from_secs(5),
        }
    }
}

impl ModuleLimits {
    /// Number of epoch ticks that make up one `max_call` budget (≥ 1).
    pub(crate) fn deadline_ticks(&self) -> u64 {
        let ticks = self.max_call.as_millis() / EPOCH_TICK.as_millis().max(1);
        (ticks as u64).max(1)
    }
}

struct HostState {
    table: ResourceTable,
    /// Per-instance memory limiter (see [`ModuleLimits`]).
    limits: StoreLimits,
    wasi: WasiCtx,
    /// wasi:http config. Used by `wasmtime-wasi-http` to drive
    /// `wasi:http/outgoing-handler` calls modules make directly.
    http: WasiHttpCtx,
    kv: Arc<Mutex<KvBackend>>,

    // Cross-module state context, valid only for the duration of one
    // `dispatch` call:
    /// Sibling snapshots available to `hypen:engine/state.read`.
    sibling_states: HashMap<String, Vec<u8>>,
    /// Modules this instance's manifest allows it to read.
    reads_allowed: HashSet<String>,
    /// Modules this instance's manifest allows it to dispatch to.
    dispatches_allowed: HashSet<String>,
    /// Sibling dispatches the running reducer requested; drained after.
    xdispatch_queue: Vec<SiblingState2>,
    /// Cross-module subscriptions the running reducer requested; drained after.
    subscribe_queue: Vec<super::SubscribeRequest>,
}

/// `(target_module, action)` queued by a `hypen:engine/state.dispatch` call.
type SiblingState2 = (String, HostAction);

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

// Cross-module state capability. ACLs enforced here against the per-call
// allow-sets the host installs from the module's manifest.
impl hypen::engine::state::Host for HostState {
    fn read(&mut self, module: String) -> Result<Vec<u8>, hypen::engine::state::Error> {
        if !self.reads_allowed.contains(&module) {
            return Err(hypen::engine::state::Error::PermissionDenied("reads".into()));
        }
        self.sibling_states
            .get(&module)
            .cloned()
            .ok_or(hypen::engine::state::Error::NotFound)
    }

    fn dispatch(
        &mut self,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        if !self.dispatches_allowed.contains(&module) {
            return Err(hypen::engine::state::Error::PermissionDenied("dispatches".into()));
        }
        self.xdispatch_queue
            .push((module, HostAction { name: action.name, payload: action.payload }));
        Ok(())
    }

    fn subscribe(
        &mut self,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), hypen::engine::state::Error> {
        // Observing state is a read: gate on the same `reads` grant.
        if !self.reads_allowed.contains(&module) {
            return Err(hypen::engine::state::Error::PermissionDenied("reads".into()));
        }
        self.subscribe_queue.push(super::SubscribeRequest {
            target: module,
            path,
            on_change,
        });
        Ok(())
    }
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
}

macro_rules! impl_kv_bucket {
    ($iface:path, $scope:expr) => {
        impl $iface for HostState {
            fn open(&mut self, tier: Tier, namespace: String) -> Result<Resource<BucketData>, StorageError> {
                Ok(HostState::open(self, $scope, tier, namespace))
            }
            fn get(&mut self, s: Resource<BucketData>, key: String) -> Result<Option<Vec<u8>>, StorageError> {
                Ok(self.b_get(&s, &key))
            }
            fn set(&mut self, s: Resource<BucketData>, key: String, value: Vec<u8>) -> Result<(), StorageError> {
                self.b_set(&s, &key, value);
                Ok(())
            }
            fn delete(&mut self, s: Resource<BucketData>, key: String) -> Result<bool, StorageError> {
                Ok(self.b_delete(&s, &key))
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

impl_kv_bucket!(hypen::storage::local::HostBucket, Scope::Local);
impl_kv_bucket!(hypen::storage::app::HostBucket, Scope::App);

impl hypen::storage::cloud::HostBucket for HostState {
    fn open(&mut self, tier: Tier, namespace: String) -> Result<Resource<BucketData>, StorageError> {
        Ok(HostState::open(self, Scope::Cloud, tier, namespace))
    }
    fn get(&mut self, s: Resource<BucketData>, key: String) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(self.b_get(&s, &key))
    }
    fn set(&mut self, s: Resource<BucketData>, key: String, value: Vec<u8>) -> Result<(), StorageError> {
        self.b_set(&s, &key, value);
        Ok(())
    }
    fn delete(&mut self, s: Resource<BucketData>, key: String) -> Result<bool, StorageError> {
        Ok(self.b_delete(&s, &key))
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
        let b = self.table.get(&s).expect("live bucket");
        let ck = composite(b, &key);
        let mut kv = self.kv.lock().unwrap();
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

/// Native module host. One per engine; owns the wasmtime engine, the
/// registered module types, and the live instances.
pub struct WasmtimeHost {
    engine: WtEngine,
    modules: HashMap<String, RegisteredModule>,
    instances: SlotMap<InstKey, InstanceData>,
    kv: Arc<Mutex<KvBackend>>,
    limits: ModuleLimits,
    /// Signals the epoch ticker to stop; set on drop.
    epoch_stop: Arc<AtomicBool>,
    /// Background thread advancing the engine's epoch (drives the per-call
    /// timeout). Joined on drop.
    ticker: Option<JoinHandle<()>>,
}

impl Drop for WasmtimeHost {
    fn drop(&mut self) {
        self.epoch_stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
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
/// Epoch timeouts and memory limits work identically under both.
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
    /// Create a host with the default [`ModuleLimits`] (256 MiB / 5 s per call).
    pub fn new() -> Result<Self, HostError> {
        Self::with_limits(ModuleLimits::default())
    }

    /// Create a host with explicit resource limits. Every instance this host
    /// creates is bounded by `limits` (memory + per-call wall-clock).
    pub fn with_limits(limits: ModuleLimits) -> Result<Self, HostError> {
        Self::with_options(limits, ExecStrategy::default())
    }

    /// Create a host with explicit limits and execution strategy
    /// ([`ExecStrategy::Interpreter`] for JIT-forbidden platforms — iOS).
    pub fn with_options(limits: ModuleLimits, strategy: ExecStrategy) -> Result<Self, HostError> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        // Epoch interruption is the timeout mechanism: a background thread
        // ticks the epoch and any call that outlives its deadline traps.
        config.epoch_interruption(true);
        if strategy == ExecStrategy::Interpreter {
            config
                .target(pulley_triple())
                .map_err(|e| HostError::Runtime(format!("pulley target: {e}")))?;
        }
        let engine = WtEngine::new(&config).map_err(|e| HostError::Runtime(e.to_string()))?;

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

        Ok(Self {
            engine,
            modules: HashMap::new(),
            instances: SlotMap::with_key(),
            kv: Arc::new(Mutex::new(KvBackend::default())),
            limits,
            epoch_stop,
            ticker: Some(ticker),
        })
    }

    /// Back `local`/`app` storage with a write-through JSON file at `path`,
    /// loading anything a previous process persisted there. Call before
    /// instantiating modules; existing in-memory contents are replaced.
    /// `cloud` stays in-memory (it simulates a sync service, not a disk).
    pub fn set_storage_path(&mut self, path: impl Into<std::path::PathBuf>) -> Result<(), HostError> {
        let backend =
            KvBackend::file_backed(path.into()).map_err(|e| HostError::Runtime(e.to_string()))?;
        *self.kv.lock().unwrap() = backend;
        Ok(())
    }

    fn build_linker(&self, manifest: &ModuleManifest) -> Result<Linker<HostState>, HostError> {
        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
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
        // their own wit-bindgen) for HTTP. Not declared in our WIT, but no
        // longer unconditional either: egress is a manifest grant enforced
        // at link time, exactly like storage — an ungranted module that
        // imports `wasi:http` fails to instantiate. (Grant defaults to true
        // for manifests that predate the gate; `"http": false` denies.)
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
                sibling_states: HashMap::new(),
                reads_allowed: HashSet::new(),
                dispatches_allowed: HashSet::new(),
                xdispatch_queue: Vec::new(),
                subscribe_queue: Vec::new(),
            },
        );
        // Enforce the memory cap, and give instantiation (which runs the
        // component's start — heavy for JS engines) a fresh time budget.
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(self.limits.deadline_ticks());
        store
    }

    fn inst(&mut self, id: ModuleInstanceId) -> Result<&mut InstanceData, HostError> {
        self.instances
            .get_mut(id_to_key(id))
            .ok_or(HostError::DeadInstance)
    }

    /// Look up an instance and arm its per-call timeout: resets the epoch
    /// deadline so this export call gets a full `max_call` budget. Call
    /// immediately before every `call_*` export.
    fn arm(&mut self, id: ModuleInstanceId) -> Result<&mut InstanceData, HostError> {
        let ticks = self.limits.deadline_ticks();
        let inst = self.inst(id)?;
        inst.store.set_epoch_deadline(ticks);
        Ok(inst)
    }
}

impl ModuleHost for WasmtimeHost {
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
        let bindings = ModuleX::instantiate(&mut store, &reg.component, &reg.linker)
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
        let inst = self.arm(id)?;
        inst.bindings
            .call_init(&mut inst.store, &config.to_vec())
            .map_err(|e| HostError::Trap(e.to_string()))?
            .map_err(HostError::ModuleError)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        // Resolve this instance's cross-module ACLs from its manifest.
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

        let inst = self.arm(id)?;

        // Install the per-call cross-module context.
        {
            let data = inst.store.data_mut();
            data.sibling_states = siblings.iter().cloned().collect();
            data.reads_allowed = reads_allowed;
            data.dispatches_allowed = dispatches_allowed;
            data.xdispatch_queue.clear();
            data.subscribe_queue.clear();
        }

        let wit_action = ActionWit { name: action.name, payload: action.payload };
        let out = inst
            .bindings
            .call_dispatch(&mut inst.store, &state.to_vec(), &wit_action)
            .map_err(|e| HostError::Trap(e.to_string()))?
            .map_err(HostError::ModuleError)?;

        // Drain the cross-module dispatch + subscribe queues the reducer
        // filled, then clear the context so it can't leak into a later call.
        let mut output = from_wit_output(out);
        let data = inst.store.data_mut();
        output.cross_dispatch = std::mem::take(&mut data.xdispatch_queue);
        output.subscribe_requests = std::mem::take(&mut data.subscribe_queue);
        data.sibling_states.clear();
        data.reads_allowed.clear();
        data.dispatches_allowed.clear();

        Ok(output)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<super::ReducerOutput, HostError> {
        // Resolve this instance's cross-module ACLs from its manifest so a hook
        // that reads / dispatches / subscribes from `on_activated` is gated
        // exactly like it is from `dispatch`.
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

        let inst = self.arm(id)?;

        // Install the per-call cross-module context.
        {
            let data = inst.store.data_mut();
            data.sibling_states = siblings.iter().cloned().collect();
            data.reads_allowed = reads_allowed;
            data.dispatches_allowed = dispatches_allowed;
            data.xdispatch_queue.clear();
            data.subscribe_queue.clear();
        }

        let out = inst
            .bindings
            .call_on_activated(&mut inst.store, &state.to_vec())
            .map_err(|e| HostError::Trap(e.to_string()))?
            .map_err(HostError::ModuleError)?;

        // Drain the cross-module dispatch + subscribe queues the hook filled,
        // then clear the context so it can't leak into a later call.
        let mut output = from_wit_output(out);
        let data = inst.store.data_mut();
        output.cross_dispatch = std::mem::take(&mut data.xdispatch_queue);
        output.subscribe_requests = std::mem::take(&mut data.subscribe_queue);
        data.sibling_states.clear();
        data.reads_allowed.clear();
        data.dispatches_allowed.clear();

        Ok(output)
    }

    fn on_deactivated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<super::ReducerOutput, HostError> {
        let inst = self.arm(id)?;
        let out = inst
            .bindings
            .call_on_deactivated(&mut inst.store, &state.to_vec())
            .map_err(|e| HostError::Trap(e.to_string()))?
            .map_err(HostError::ModuleError)?;
        Ok(from_wit_output(out))
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        let inst = self.arm(id)?;
        inst.bindings
            .call_on_destroyed(&mut inst.store, &state.to_vec())
            .map_err(|e| HostError::Trap(e.to_string()))?
            .map_err(HostError::ModuleError)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        let inst = self.arm(id)?;
        inst.bindings
            .call_actions(&mut inst.store)
            .map_err(|e| HostError::Trap(e.to_string()))
    }
}
