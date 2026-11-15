//! Resource limits: what a module instance may consume, and the limiter that
//! enforces the memory part.

use std::time::Duration;

use wasmtime::ResourceLimiter;

use crate::module_host::kv::KvQuota;

/// Most cross-module requests (`hypen:engine/state.dispatch` and, counted
/// separately, `.subscribe`) one guest call may queue. Further requests fail
/// with an error instead of growing host memory.
pub(crate) const MAX_CROSS_MODULE_REQUESTS: usize = 256;
/// Largest single cross-module request (names + payload), in bytes.
pub(crate) const MAX_CROSS_MODULE_REQUEST_BYTES: usize = 1024 * 1024;

// The bounds on `hypen:http/deferred` requests are part of the contract
// rather than of this host, so they live with the value types:
// `MAX_HTTP_*` in `module_host/http.rs`.

/// Most `hypen:storage` bucket handles one instance may hold open at once.
/// Each handle pins a host-side copy of its namespace, so without a bound a
/// guest opening buckets in a loop grows host memory outside its own budget.
pub(crate) const MAX_OPEN_BUCKETS: usize = 256;
/// Longest bucket namespace, in bytes (see [`MAX_OPEN_BUCKETS`]).
pub(crate) const MAX_NAMESPACE_BYTES: usize = 4 * 1024;
/// Capacity of an instance's host resource table — bucket handles plus every
/// WASI resource (streams, pollables, HTTP requests). wasmtime's default is a
/// million entries; nothing a reducer does legitimately needs that many.
pub(crate) const MAX_RESOURCE_TABLE_ENTRIES: usize = 16 * 1024;

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
    /// A growth was refused since the flag was last cleared. A denied
    /// `memory.grow` is not itself a trap — the guest's allocator sees the
    /// failure and typically aborts — so this is how a trap that follows is
    /// attributed to the memory limit.
    denied: bool,
}

impl TotalMemoryLimiter {
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            budget,
            used: 0,
            denied: false,
        }
    }

    pub(crate) fn budget(&self) -> usize {
        self.budget
    }

    /// Whether a growth was denied since the last call, clearing the flag.
    pub(crate) fn take_denied(&mut self) -> bool {
        std::mem::take(&mut self.denied)
    }

    fn charge(&mut self, bytes: usize) -> bool {
        match self.used.checked_add(bytes) {
            Some(next) if next <= self.budget => {
                self.used = next;
                true
            }
            _ => {
                self.denied = true;
                false
            }
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
        match elements.checked_mul(std::mem::size_of::<usize>()) {
            Some(bytes) => Ok(self.charge(bytes)),
            None => {
                self.denied = true;
                Ok(false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::{Engine, Instance, Module, Store, Table};

    const PAGE: usize = 64 * 1024;

    /// The budget is a total across memories: a module with two linear
    /// memories can't hold more than the budget between them, however the
    /// growth is split — which a per-memory cap would allow.
    #[test]
    fn memory_budget_is_summed_across_linear_memories() {
        let engine = Engine::default();
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
        assert!(!store.data_mut().take_denied(), "nothing refused yet");
        assert!(a.grow(&mut store, 1).is_err(), "a: over the total budget");
        assert!(b.grow(&mut store, 1).is_err(), "b: over the total budget");
        assert_eq!(a.size(&store) + b.size(&store), 4);
        assert!(store.data_mut().take_denied(), "the refusal is recorded");
        assert!(!store.data_mut().take_denied(), "and reading it clears it");

        // A second instance in the same store draws on the same budget.
        assert!(Instance::new(&mut store, &module, &[]).is_err());
    }

    /// Initial memories count too: a component can't dodge the budget by
    /// declaring many memories that never grow.
    #[test]
    fn memory_budget_covers_initial_sizes() {
        let engine = Engine::default();
        let mut store = Store::new(&engine, TotalMemoryLimiter::new(3 * PAGE));
        store.limiter(|limiter| limiter);
        let module = Module::new(&engine, r#"(module (memory 2) (memory 2))"#).unwrap();
        assert!(Instance::new(&mut store, &module, &[]).is_err());
    }

    /// Tables are charged against the same budget (a pointer per element).
    #[test]
    fn memory_budget_covers_tables() {
        let engine = Engine::default();
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
        table
            .grow(&mut store, 6, wasmtime::Ref::Func(None))
            .unwrap();
        assert!(table
            .grow(&mut store, 1, wasmtime::Ref::Func(None))
            .is_err());
    }
}
