//! The `hypen:module@0.2.0` ABI: component-model async.
//!
//! Glue only, like `v01.rs`. What differs from v0.1 is the shape wasmtime
//! gives CM-async bindings (wasmtime 46, `component-model-async`):
//!
//! - WIT `async func` imports land on `*WithStore` traits whose methods take
//!   an `&Accessor` and return futures. The storage and state backends are
//!   in-memory, so each is an immediately-ready future around a synchronous
//!   `Accessor::with` window — but the guest still suspends and resumes
//!   through the component event loop.
//! - Exports are `call_x(accessor, …)` futures driven by
//!   `Store::run_concurrent`, which pumps the store's event loop.
//! - Once any CM-async import is linked the store requires async
//!   entrypoints for everything, so the sync `actions` export is lifted
//!   onto the concurrent path too (`exports: { "actions": async | store }`).
//!
//! v0.2 adds `hypen:time/clock`, and its blob buckets move payloads as
//! `stream<u8>` (unimplemented here, as in v0.1).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use wasmtime::component::{Accessor, HasData, InstancePre, Resource, StreamReader};
use wasmtime::Store;

use super::host::{Abi, Host, Reply};
use super::linker::{self, Capability, LinkFn};
use super::storage::{Blob, Bucket};
use super::store::{HostClock, HostState};
use crate::module_host::{HostAction, StorageScope};

// WIT-declared `async func` gets ASYNC|STORE flags automatically; only the
// sync `actions` export needs lifting onto the concurrent call path.
// Resource `with` keys use the 46-era dot form.
wasmtime::component::bindgen!({
    path: "../wit-v0_2",
    world: "module-x",
    with: {
        "hypen:storage/local.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/app.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/cloud.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/local.blob-bucket": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/app.blob-bucket": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/cloud.blob-bucket": crate::module_host::wasmtime::storage::Blob,
    },
    exports: { "actions": async | store },
});

super::wit_glue::wit_conversions!();

use hypen::storage::types::{EntryInfo, Error as StorageError, Tier};

// ── imports ─────────────────────────────────────────────────────────────────

/// `HasData` marker projecting the store data for the `*WithStore` impls
/// (CM-async imports don't borrow the store across await points; they get
/// synchronous windows via `Accessor::with`).
struct HostCap;

impl HasData for HostCap {
    type Data<'a> = &'a mut HostState;
}

type Access = Accessor<HostState, HostCap>;

impl hypen::storage::types::Host for HostState {}
impl hypen::module::types::Host for HostState {}
impl hypen::storage::local::Host for HostState {}
impl hypen::storage::app::Host for HostState {}
impl hypen::storage::cloud::Host for HostState {}
impl hypen::engine::state::Host for HostState {}

/// Per-scope forwarding, as in `v01.rs`. `$extra` holds the methods only
/// some scopes have (`clear` on local/app, `compare-and-set` on cloud).
macro_rules! forward_bucket {
    ($iface:ident, $scope:expr, { $($extra:tt)* }) => {
        impl hypen::storage::$iface::HostBucketWithStore<HostState> for HostCap {
            async fn open(
                a: &Access,
                tier: Tier,
                ns: String,
            ) -> Result<Resource<Bucket>, StorageError> {
                Ok(a.with(|mut s| s.get().bucket_open($scope, tier.into(), &ns))?)
            }
            async fn get(
                a: &Access,
                b: Resource<Bucket>,
                key: String,
            ) -> Result<Option<Vec<u8>>, StorageError> {
                Ok(a.with(|mut s| s.get().bucket_get(&b, &key))?)
            }
            async fn set(
                a: &Access,
                b: Resource<Bucket>,
                key: String,
                value: Vec<u8>,
            ) -> Result<(), StorageError> {
                Ok(a.with(|mut s| s.get().bucket_set(&b, &key, value))?)
            }
            async fn delete(
                a: &Access,
                b: Resource<Bucket>,
                key: String,
            ) -> Result<bool, StorageError> {
                Ok(a.with(|mut s| s.get().bucket_delete(&b, &key))?)
            }
            async fn keys(
                a: &Access,
                b: Resource<Bucket>,
                prefix: String,
                limit: u32,
            ) -> Result<Vec<String>, StorageError> {
                Ok(a.with(|mut s| s.get().bucket_keys(&b, &prefix, limit))?)
            }
            async fn info(
                a: &Access,
                b: Resource<Bucket>,
                key: String,
            ) -> Result<Option<EntryInfo>, StorageError> {
                Ok(a.with(|mut s| s.get().bucket_info(&b, &key))?.map(Into::into))
            }
            $($extra)*
        }
        impl hypen::storage::$iface::HostBucket for HostState {
            fn drop(&mut self, b: Resource<Bucket>) -> wasmtime::Result<()> {
                self.bucket_drop(b)
            }
        }
    };
}

forward_bucket!(local, StorageScope::Local, {
    async fn clear(a: &Access, b: Resource<Bucket>) -> Result<(), StorageError> {
        Ok(a.with(|mut s| s.get().bucket_clear(&b))?)
    }
});
forward_bucket!(app, StorageScope::App, {
    async fn clear(a: &Access, b: Resource<Bucket>) -> Result<(), StorageError> {
        Ok(a.with(|mut s| s.get().bucket_clear(&b))?)
    }
});
forward_bucket!(cloud, StorageScope::Cloud, {
    async fn compare_and_set(
        a: &Access,
        b: Resource<Bucket>,
        key: String,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        Ok(a.with(|mut s| s.get().bucket_compare_and_set(&b, &key, expected, value))?)
    }
});

/// Blobs are not implemented: every operation answers `unavailable` (see
/// `v01.rs`). The `stream<u8>` signatures pass through bindgen untouched.
macro_rules! forward_blobs {
    ($iface:ident) => {
        impl hypen::storage::$iface::HostBlobBucketWithStore<HostState> for HostCap {
            async fn open(a: &Access, _: Tier, _: String) -> Result<Resource<Blob>, StorageError> {
                Ok(a.with(|mut s| s.get().blob_unavailable())?)
            }
            async fn get(
                a: &Access,
                _: Resource<Blob>,
                _: String,
            ) -> Result<Option<StreamReader<u8>>, StorageError> {
                Ok(a.with(|mut s| s.get().blob_unavailable())?)
            }
            async fn put(
                a: &Access,
                _: Resource<Blob>,
                _: String,
                _: StreamReader<u8>,
            ) -> Result<EntryInfo, StorageError> {
                Ok(a.with(|mut s| s.get().blob_unavailable())?)
            }
            async fn delete(
                a: &Access,
                _: Resource<Blob>,
                _: String,
            ) -> Result<bool, StorageError> {
                Ok(a.with(|mut s| s.get().blob_unavailable())?)
            }
            async fn keys(
                a: &Access,
                _: Resource<Blob>,
                _: String,
                _: u32,
            ) -> Result<Vec<String>, StorageError> {
                Ok(a.with(|mut s| s.get().blob_unavailable())?)
            }
        }
        impl hypen::storage::$iface::HostBlobBucket for HostState {
            fn drop(&mut self, blob: Resource<Blob>) -> wasmtime::Result<()> {
                self.blob_drop(blob)
            }
        }
    };
}

forward_blobs!(local);
forward_blobs!(app);
forward_blobs!(cloud);

impl hypen::engine::state::HostWithStore<HostState> for HostCap {
    async fn read(a: &Access, module: String) -> Result<Vec<u8>, hypen::engine::state::Error> {
        Ok(a.with(|mut s| s.get().cross.read(&module))?)
    }

    async fn dispatch(
        a: &Access,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        Ok(a.with(|mut s| s.get().cross.dispatch(module, action.into()))?)
    }

    async fn subscribe(
        a: &Access,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), hypen::engine::state::Error> {
        Ok(a.with(|mut s| s.get().cross.subscribe(module, path, on_change))?)
    }
}

// hypen:time. Reads are sync (they never block); sleep is CM-async so the
// guest task suspends through the component event loop.
impl hypen::time::clock::Host for HostState {
    fn now_ms(&mut self) -> u64 {
        self.clock.now_ms()
    }

    fn monotonic_ms(&mut self) -> u64 {
        self.clock.monotonic_ms()
    }
}

impl hypen::time::clock::HostWithStore<HostState> for HostCap {
    async fn sleep_ms(a: &Access, ms: u64) {
        match a.with(|mut s| s.get().clock.clone()) {
            // A virtual clock resumes instantly and advances the counter,
            // which is what makes replay deterministic.
            HostClock::Virtual(counter) => {
                counter.fetch_add(ms, Ordering::Relaxed);
            }
            // Suspends the guest task on the host's runtime (the host thread
            // is not parked). No cap needed: the per-call deadline cancels
            // the call if the sleep outlives the budget.
            HostClock::Real { .. } => tokio::time::sleep(Duration::from_millis(ms)).await,
        }
    }
}

// ── exports ─────────────────────────────────────────────────────────────────

/// Marker for the `hypen:module@0.2.0` ABI.
pub struct V02;

impl Abi for V02 {
    const VERSION: &'static str = "0.2.0";
    const WORLD: &'static str = "hypen:module@0.2.0";
    const CAPABILITIES: &'static [(Capability, LinkFn)] = &[
        (Capability::Storage(StorageScope::Local), |l| {
            hypen::storage::local::add_to_linker::<HostState, HostCap>(l, |s| s)
        }),
        (Capability::Storage(StorageScope::App), |l| {
            hypen::storage::app::add_to_linker::<HostState, HostCap>(l, |s| s)
        }),
        (Capability::Storage(StorageScope::Cloud), |l| {
            hypen::storage::cloud::add_to_linker::<HostState, HostCap>(l, |s| s)
        }),
        (Capability::EngineState, |l| {
            hypen::engine::state::add_to_linker::<HostState, HostCap>(l, |s| s)
        }),
        (Capability::Time, |l| {
            hypen::time::clock::add_to_linker::<HostState, HostCap>(l, |s| s)
        }),
        linker::HTTP,
    ];

    type Pre = ModuleXPre<HostState>;
    type Bindings = ModuleX;

    fn prepare(pre: InstancePre<HostState>) -> wasmtime::Result<Self::Pre> {
        ModuleXPre::new(pre)
    }

    async fn instantiate(
        pre: &Self::Pre,
        store: &mut Store<HostState>,
    ) -> wasmtime::Result<Self::Bindings> {
        pre.instantiate_async(store).await
    }

    async fn init(b: &ModuleX, store: &mut Store<HostState>, config: Vec<u8>) -> Reply<Vec<u8>> {
        store
            .run_concurrent(async |a| b.call_init(a, config).await)
            .await?
    }

    async fn dispatch(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
        action: HostAction,
    ) -> Reply<crate::module_host::ReducerOutput> {
        let reply = store
            .run_concurrent(async |a| b.call_dispatch(a, state, action.into()).await)
            .await??;
        Ok(reply.map(Into::into))
    }

    async fn on_activated(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
    ) -> Reply<crate::module_host::ReducerOutput> {
        let reply = store
            .run_concurrent(async |a| b.call_on_activated(a, state).await)
            .await??;
        Ok(reply.map(Into::into))
    }

    async fn on_deactivated(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
    ) -> Reply<crate::module_host::ReducerOutput> {
        let reply = store
            .run_concurrent(async |a| b.call_on_deactivated(a, state).await)
            .await??;
        Ok(reply.map(Into::into))
    }

    async fn on_destroyed(b: &ModuleX, store: &mut Store<HostState>, state: Vec<u8>) -> Reply<()> {
        store
            .run_concurrent(async |a| b.call_on_destroyed(a, state).await)
            .await?
    }

    async fn actions(b: &ModuleX, store: &mut Store<HostState>) -> wasmtime::Result<Vec<String>> {
        store
            .run_concurrent(async |a| b.call_actions(a).await)
            .await?
    }
}

impl Host<V02> {
    /// Swap in a deterministic clock starting at `start_ms`. Returns the
    /// counter so callers can advance or inspect it; existing instances
    /// keep the clock they were created with.
    pub fn set_virtual_clock(&mut self, start_ms: u64) -> Arc<AtomicU64> {
        let counter = Arc::new(AtomicU64::new(start_ms));
        self.set_clock(HostClock::Virtual(Arc::clone(&counter)));
        counter
    }
}
