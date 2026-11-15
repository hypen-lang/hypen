//! Per-instance host state: everything a guest's imports can reach.
//!
//! One [`HostState`] lives in each instance's wasmtime `Store`, and it is the
//! *only* thing host imports get a reference to. It holds no handle to the
//! host, to other instances or to their stores, so an import cannot call
//! back into a guest: host→guest re-entrancy is impossible by construction.
//! Both ABIs use this same type; the generated import traits of each world
//! are implemented for it in `v01.rs` / `v02.rs`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use wasmtime::component::ResourceTable;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};
use wasmtime_wasi_http::WasiHttpCtx;

use super::cross_module::CrossModuleCtx;
use super::limits::{ModuleLimits, TotalMemoryLimiter, MAX_RESOURCE_TABLE_ENTRIES};
use super::storage::{SharedKv, StorageCtx};
use crate::module_host::kv::ModuleName;

/// The clock behind `hypen:time/clock`. `Real` reads the OS; `Virtual` is a
/// counter — reads return it, `sleep-ms` advances it without waiting — which
/// makes reducer runs deterministically replayable.
#[derive(Clone)]
pub(crate) enum HostClock {
    Real {
        /// Origin for `monotonic-ms`.
        origin: Instant,
    },
    Virtual(Arc<AtomicU64>),
}

impl HostClock {
    pub(crate) fn real() -> Self {
        Self::Real {
            origin: Instant::now(),
        }
    }

    pub(crate) fn now_ms(&self) -> u64 {
        match self {
            Self::Real { .. } => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
                // A system clock set before 1970 reads as the epoch.
                .unwrap_or(0),
            Self::Virtual(c) => c.load(Ordering::Relaxed),
        }
    }

    pub(crate) fn monotonic_ms(&self) -> u64 {
        match self {
            Self::Real { origin } => {
                u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX)
            }
            Self::Virtual(c) => c.load(Ordering::Relaxed),
        }
    }
}

/// Store data of one module instance.
pub(crate) struct HostState {
    /// Host resources the guest holds handles to: buckets, WASI streams,
    /// pollables, HTTP requests. Capacity-bounded.
    pub(crate) table: ResourceTable,
    /// Per-instance total-memory limiter (see [`ModuleLimits`]).
    pub(crate) limiter: TotalMemoryLimiter,
    /// An empty WASI context: no preopened directories, no environment, no
    /// arguments, no inherited stdio, no network.
    wasi: WasiCtx,
    /// `wasi:http` state. Only reachable when the manifest grants `http`
    /// (the interface is not linked otherwise).
    http: WasiHttpCtx,
    /// `hypen:storage`: the shared backend plus this instance's identity.
    pub(crate) storage: StorageCtx,
    /// `hypen:time` (v0.2 only; the v0.1 world has no clock import).
    pub(crate) clock: HostClock,
    /// `hypen:engine/state` context of the call in progress.
    pub(crate) cross: CrossModuleCtx,
}

impl HostState {
    pub(crate) fn new(
        module: ModuleName,
        kv: SharedKv,
        clock: HostClock,
        limits: &ModuleLimits,
    ) -> Self {
        let mut table = ResourceTable::new();
        table.set_max_capacity(MAX_RESOURCE_TABLE_ENTRIES);
        Self {
            table,
            limiter: TotalMemoryLimiter::new(limits.max_memory_bytes),
            wasi: WasiCtxBuilder::new().build(),
            http: WasiHttpCtx::new(),
            storage: StorageCtx::new(module, kv, limits.kv_quota()),
            clock,
            cross: CrossModuleCtx::default(),
        }
    }
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
