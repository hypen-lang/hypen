//! The `hypen:module@0.1.0` ABI: synchronous WIT signatures.
//!
//! This file is glue only — the `bindgen!` invocation, the generated import
//! traits forwarded to the shared implementations, and the [`Abi`] adapter
//! that calls the generated exports. Policy lives in the sibling modules.

use wasmtime::component::{HasSelf, InstancePre, Resource};
use wasmtime::Store;

use super::host::{Abi, Reply};
use super::linker::{self, Capability, LinkFn};
use super::storage::{Blob, Bucket};
use super::store::HostState;
use crate::module_host::{HostAction, StorageScope};

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
        "hypen:storage/local.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/app.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/cloud.bucket": crate::module_host::wasmtime::storage::Bucket,
        "hypen:storage/local.blob-handle": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/app.blob-handle": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/cloud.blob-handle": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/local.blob-writer": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/app.blob-writer": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/cloud.blob-writer": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/local.blob-bucket": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/app.blob-bucket": crate::module_host::wasmtime::storage::Blob,
        "hypen:storage/cloud.blob-bucket": crate::module_host::wasmtime::storage::Blob,
    },
    // Exports are called through `call_async` so a guest parked in an async
    // WASI host call suspends back to the host's runtime, where the per-call
    // timeout can cancel it. (The hypen:* imports below stay plain sync
    // functions: they never block.)
    exports: { default: async },
});

super::wit_glue::wit_conversions!();

use hypen::storage::types::{EntryInfo, Error as StorageError, Tier};

// ── imports ─────────────────────────────────────────────────────────────────

impl hypen::storage::types::Host for HostState {}
impl hypen::module::types::Host for HostState {}
impl hypen::storage::local::Host for HostState {}
impl hypen::storage::app::Host for HostState {}
impl hypen::storage::cloud::Host for HostState {}

/// The three scopes are sister interfaces with their own generated traits,
/// so the forwarding is stamped out per scope. `$extra` holds the methods
/// only some scopes have (`clear` on local/app, `compare-and-set` on cloud).
macro_rules! forward_bucket {
    ($iface:ident, $scope:expr, { $($extra:tt)* }) => {
        impl hypen::storage::$iface::HostBucket for HostState {
            fn open(&mut self, tier: Tier, ns: String) -> Result<Resource<Bucket>, StorageError> {
                Ok(self.bucket_open($scope, tier.into(), &ns)?)
            }
            fn get(
                &mut self,
                b: Resource<Bucket>,
                key: String,
            ) -> Result<Option<Vec<u8>>, StorageError> {
                Ok(self.bucket_get(&b, &key)?)
            }
            fn set(
                &mut self,
                b: Resource<Bucket>,
                key: String,
                value: Vec<u8>,
            ) -> Result<(), StorageError> {
                Ok(self.bucket_set(&b, &key, value)?)
            }
            fn delete(&mut self, b: Resource<Bucket>, key: String) -> Result<bool, StorageError> {
                Ok(self.bucket_delete(&b, &key)?)
            }
            fn keys(
                &mut self,
                b: Resource<Bucket>,
                prefix: String,
                limit: u32,
            ) -> Result<Vec<String>, StorageError> {
                Ok(self.bucket_keys(&b, &prefix, limit)?)
            }
            fn info(
                &mut self,
                b: Resource<Bucket>,
                key: String,
            ) -> Result<Option<EntryInfo>, StorageError> {
                Ok(self.bucket_info(&b, &key)?.map(Into::into))
            }
            fn drop(&mut self, b: Resource<Bucket>) -> wasmtime::Result<()> {
                self.bucket_drop(b)
            }
            $($extra)*
        }
    };
}

forward_bucket!(local, StorageScope::Local, {
    fn clear(&mut self, b: Resource<Bucket>) -> Result<(), StorageError> {
        Ok(self.bucket_clear(&b)?)
    }
});
forward_bucket!(app, StorageScope::App, {
    fn clear(&mut self, b: Resource<Bucket>) -> Result<(), StorageError> {
        Ok(self.bucket_clear(&b)?)
    }
});
forward_bucket!(cloud, StorageScope::Cloud, {
    fn compare_and_set(
        &mut self,
        b: Resource<Bucket>,
        key: String,
        expected: Option<u64>,
        value: Vec<u8>,
    ) -> Result<u64, StorageError> {
        Ok(self.bucket_compare_and_set(&b, &key, expected, value)?)
    }
});

/// Blobs are not implemented. `blob-bucket.open` answers `unavailable`, so
/// no blob handle ever exists and the other methods cannot be reached; they
/// answer `unavailable` too rather than pretend to be an empty store.
macro_rules! forward_blobs {
    ($iface:ident) => {
        impl hypen::storage::$iface::HostBlobBucket for HostState {
            fn open(&mut self, _: Tier, _: String) -> Result<Resource<Blob>, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn get(
                &mut self,
                _: Resource<Blob>,
                _: String,
            ) -> Result<Option<Resource<Blob>>, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn put(
                &mut self,
                _: Resource<Blob>,
                _: String,
            ) -> Result<Resource<Blob>, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn delete(&mut self, _: Resource<Blob>, _: String) -> Result<bool, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn keys(
                &mut self,
                _: Resource<Blob>,
                _: String,
                _: u32,
            ) -> Result<Vec<String>, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn drop(&mut self, blob: Resource<Blob>) -> wasmtime::Result<()> {
                self.blob_drop(blob)
            }
        }
        impl hypen::storage::$iface::HostBlobHandle for HostState {
            // Infallible in the WIT; unreachable without a handle.
            fn size(&mut self, _: Resource<Blob>) -> u64 {
                0
            }
            fn read(&mut self, _: Resource<Blob>, _: u64, _: u32) -> Result<Vec<u8>, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn drop(&mut self, blob: Resource<Blob>) -> wasmtime::Result<()> {
                self.blob_drop(blob)
            }
        }
        impl hypen::storage::$iface::HostBlobWriter for HostState {
            fn write(&mut self, _: Resource<Blob>, _: Vec<u8>) -> Result<(), StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn finish(&mut self, _: Resource<Blob>) -> Result<EntryInfo, StorageError> {
                Ok(self.blob_unavailable()?)
            }
            fn abort(&mut self, _: Resource<Blob>) {}
            fn drop(&mut self, blob: Resource<Blob>) -> wasmtime::Result<()> {
                self.blob_drop(blob)
            }
        }
    };
}

forward_blobs!(local);
forward_blobs!(app);
forward_blobs!(cloud);

impl hypen::engine::state::Host for HostState {
    fn read(&mut self, module: String) -> Result<Vec<u8>, hypen::engine::state::Error> {
        Ok(self.cross.read(&module)?)
    }

    fn dispatch(
        &mut self,
        module: String,
        action: hypen::engine::state::Action,
    ) -> Result<(), hypen::engine::state::Error> {
        Ok(self.cross.dispatch(module, action.into())?)
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

// ── exports ─────────────────────────────────────────────────────────────────

/// Marker for the `hypen:module@0.1.0` ABI.
pub struct V01;

impl Abi for V01 {
    const VERSION: &'static str = "0.1.0";
    const WORLD: &'static str = "hypen:module@0.1.0";
    const CAPABILITIES: &'static [(Capability, LinkFn)] = &[
        (Capability::Storage(StorageScope::Local), |l| {
            hypen::storage::local::add_to_linker::<_, HasSelf<_>>(l, |s| s)
        }),
        (Capability::Storage(StorageScope::App), |l| {
            hypen::storage::app::add_to_linker::<_, HasSelf<_>>(l, |s| s)
        }),
        (Capability::Storage(StorageScope::Cloud), |l| {
            hypen::storage::cloud::add_to_linker::<_, HasSelf<_>>(l, |s| s)
        }),
        (Capability::EngineState, |l| {
            hypen::engine::state::add_to_linker::<_, HasSelf<_>>(l, |s| s)
        }),
        (Capability::DeferredHttp, |l| {
            hypen::http::deferred::add_to_linker::<_, HasSelf<_>>(l, |s| s)
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
        b.call_init(store, &config).await
    }

    async fn dispatch(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
        action: HostAction,
    ) -> Reply<crate::module_host::ReducerOutput> {
        let reply = b.call_dispatch(store, &state, &action.into()).await?;
        Ok(reply.map(Into::into))
    }

    async fn on_activated(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
    ) -> Reply<crate::module_host::ReducerOutput> {
        Ok(b.call_on_activated(store, &state).await?.map(Into::into))
    }

    async fn on_deactivated(
        b: &ModuleX,
        store: &mut Store<HostState>,
        state: Vec<u8>,
    ) -> Reply<crate::module_host::ReducerOutput> {
        Ok(b.call_on_deactivated(store, &state).await?.map(Into::into))
    }

    async fn on_destroyed(b: &ModuleX, store: &mut Store<HostState>, state: Vec<u8>) -> Reply<()> {
        b.call_on_destroyed(store, &state).await
    }

    async fn actions(b: &ModuleX, store: &mut Store<HostState>) -> wasmtime::Result<Vec<String>> {
        b.call_actions(store).await
    }
}
