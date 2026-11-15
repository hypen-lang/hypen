//! The native module hosts: `hypen:module` WASM components on wasmtime.
//!
//! One implementation, [`Host`], generic over the module ABI. The two
//! contract versions differ only in their `bindgen!` output, isolated in
//! `v01.rs` (sync WIT) and `v02.rs` (component-model async):
//!
//! - [`WasmtimeHost`] = `Host<V01>` — `hypen:module@0.1.0`
//! - [`WasmtimeHostAsync`] = `Host<V02>` — `hypen:module@0.2.0`
//!
//! ## Sandbox model
//!
//! **Link time — what a module can import.** Manifests are deny-by-default.
//! A storage scope or `wasi:http` the manifest does not grant is not linked,
//! so a component importing it cannot be instantiated; the error names the
//! import and the missing grant (`linker.rs`). WASI is an empty context: no
//! filesystem, environment, arguments or sockets.
//!
//! **Call time — what a call can do.**
//! - *Deadline.* Every guest entry (component start, `init`, `dispatch`, the
//!   lifecycle hooks, `actions`) runs under `ModuleLimits::max_call`,
//!   measured from the start of that call and enforced twice: epoch
//!   interruption traps guest code still running at the deadline, and a
//!   wall-clock timeout cancels a call parked in a host call (`core.rs`).
//! - *Memory.* One budget over all of an instance's linear memories and
//!   tables (`limits.rs`); host-side resources a guest can pin (bucket
//!   handles, the resource table, queued cross-module requests) are bounded
//!   separately.
//! - *Cross-module access.* `hypen:engine/state` is checked per target
//!   against the manifest's `reads` / `dispatches`, and only inside
//!   `dispatch` / `on-activated`. Requests are queued for the engine, never
//!   executed inline, and imports can reach nothing but their own
//!   instance's state — a guest cannot re-enter a guest (`cross_module.rs`,
//!   `store.rs`).
//! - *Storage.* `local` is partitioned by the registered module name, which
//!   the guest cannot influence; `app` / `cloud` are shared between the
//!   modules granted them. Writes are quota-checked and flushed once at the
//!   end of each call (`storage.rs`, `../kv.rs`).
//!
//! **What kills an instance.** A trap, a deadline overrun, or a failed host
//! call leaves guest memory mid-call, so the instance's store is dropped and
//! the instance is dead: later calls return `HostError::DeadInstance`
//! ([`Host::death_reason`] says why) until it is destroyed. An export that
//! returns `Err(string)` is an ordinary module error and kills nothing.
//!
//! Error mapping is centralised in `error.rs`.

mod core;
mod cross_module;
mod error;
mod host;
mod instances;
mod limits;
mod linker;
mod storage;
mod store;
mod v01;
mod v02;
mod wit_glue;

pub use self::core::ExecStrategy;
pub use self::host::Host;
pub use self::limits::ModuleLimits;

pub(crate) use self::host::Shared;
pub(crate) use self::instances::IdTag;

/// Native host for `hypen:module@0.1.0` components (sync reducer ABI).
pub type WasmtimeHost = Host<v01::V01>;

/// Native host for `hypen:module@0.2.0` components (component-model async:
/// reducers `await` their capability imports inline). Sync-facing like
/// [`WasmtimeHost`]; each call pumps the store's event loop to completion.
pub type WasmtimeHostAsync = Host<v02::V02>;
