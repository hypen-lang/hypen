//! [`DualHost`] — the v0.1/v0.2 coexistence mux, as a library type.
//!
//! One host that speaks both module ABIs: `register` sniffs which world the
//! component bytes target and routes every subsequent call to the matching
//! native host ([`WasmtimeHost`] for `hypen:module@0.1.0`,
//! [`WasmtimeHostAsync`] for `@0.2.0`). This is what lets one app mix sync
//! and async modules freely with no wrapping and no cutover — and it is the
//! type platform embeddings (hypen-runtime, the uniffi mobile surface)
//! should hold, so ABI evolution never leaks into their API.
//!
//! Promoted out of the `hypen-runtime` binary so mobile/desktop embeddings
//! link the same code the dev runtime runs.

use std::collections::HashMap;
use std::path::Path;

use super::kv::KvBackend;
use super::wasmtime::{IdTag, Shared};
use super::{
    ExecStrategy, HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleLimits,
    ModuleManifest, ReducerOutput, SiblingState, WasmtimeHost, WasmtimeHostAsync,
};

/// Which `hypen:module` world a component targets.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModuleAbi {
    /// `hypen:module@0.1.0` — sync reducer (TS/Go/Rust today).
    V1Sync,
    /// `hypen:module@0.2.0` — CM-async reducer, awaited capability imports.
    V2Async,
}

/// Sniff a component's ABI from its bytes. Component import names are stored
/// verbatim in the binary, and only a v0.2 module can import the `@0.2.0`
/// hypen capability interfaces, so a substring scan is a reliable
/// discriminator without paying for a second compile.
pub fn detect_abi(bytes: &[u8]) -> ModuleAbi {
    const MARKERS: [&[u8]; 5] = [
        b"hypen:storage/local@0.2.0",
        b"hypen:storage/app@0.2.0",
        b"hypen:storage/cloud@0.2.0",
        b"hypen:engine/state@0.2.0",
        b"hypen:time/clock@0.2.0",
    ];
    let hit = MARKERS
        .iter()
        .any(|m| bytes.windows(m.len()).any(|w| w == *m));
    if hit {
        ModuleAbi::V2Async
    } else {
        ModuleAbi::V1Sync
    }
}

/// [`ModuleHost`] mux over both native hosts. `register` sniffs each
/// component's ABI; re-registering the same name re-sniffs (so hot reload
/// can change a module's ABI across a rebuild). Instance ids carry a tag
/// saying which host issued them, so calls route without a lookup.
pub struct DualHost {
    v1: WasmtimeHost,
    v2: WasmtimeHostAsync,
    /// Which host holds the current registration of each name.
    routing: HashMap<String, ModuleAbi>,
}

impl DualHost {
    /// Default limits, JIT execution, in-memory storage.
    pub fn new() -> Result<Self, HostError> {
        Self::with_options(ModuleLimits::default(), ExecStrategy::default(), None)
    }

    /// Full construction surface: limits + execution strategy (use
    /// [`ExecStrategy::Interpreter`] on JIT-forbidden platforms — iOS) +
    /// optional persistent-storage directory.
    ///
    /// Both ABI hosts run on one core (a single wasmtime engine, epoch-ticker
    /// thread and runtime, all stopped when the `DualHost` drops) and one
    /// storage backend: `local` data is private per registered module name
    /// whichever ABI the module uses, and the `app` scope is shared between
    /// granted modules across ABIs. With `data_dir`, storage persists to
    /// `<data_dir>/storage.json`; an unreadable or other-format file there
    /// is an error.
    pub fn with_options(
        limits: ModuleLimits,
        strategy: ExecStrategy,
        data_dir: Option<&Path>,
    ) -> Result<Self, HostError> {
        let backend = match data_dir {
            Some(dir) => KvBackend::file_backed(dir.join("storage.json"))
                .map_err(|e| HostError::Runtime(e.to_string()))?,
            None => KvBackend::default(),
        };
        let shared = Shared::new(strategy, backend)?;
        Ok(Self {
            v1: WasmtimeHost::on(shared.clone(), limits, IdTag::Plain),
            v2: WasmtimeHostAsync::on(shared, limits, IdTag::Async),
            routing: HashMap::new(),
        })
    }

    /// The two inner hosts, for host-specific knobs (e.g.
    /// [`WasmtimeHostAsync::set_virtual_clock`]).
    pub fn hosts_mut(&mut self) -> (&mut WasmtimeHost, &mut WasmtimeHostAsync) {
        (&mut self.v1, &mut self.v2)
    }

    /// Persist pending storage changes now (see
    /// [`WasmtimeHost::flush_storage`]). One backend serves both hosts.
    pub fn flush_storage(&mut self) -> Result<(), HostError> {
        self.v1.flush_storage()
    }

    /// Why the instance behind `id` is dead (see
    /// [`WasmtimeHost::death_reason`]).
    pub fn death_reason(&self, id: ModuleInstanceId) -> Option<String> {
        match IdTag::of(id) {
            IdTag::Plain => self.v1.death_reason(id),
            IdTag::Async => self.v2.death_reason(id),
        }
    }

    /// The host that issued `id`. An id from neither simply misses there.
    fn host_of(&mut self, id: ModuleInstanceId) -> &mut dyn ModuleHost {
        match IdTag::of(id) {
            IdTag::Plain => &mut self.v1,
            IdTag::Async => &mut self.v2,
        }
    }
}

impl ModuleHost for DualHost {
    /// Register with the host for the component's ABI. If the name was
    /// registered under the other ABI, that registration is dropped so the
    /// name resolves to exactly one module; instances already created from
    /// it keep running until destroyed. A failed registration changes
    /// nothing.
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        let abi = detect_abi(component_bytes);
        match abi {
            ModuleAbi::V1Sync => {
                self.v1.register(name, component_bytes, manifest)?;
                self.v2.unregister(name);
            }
            ModuleAbi::V2Async => {
                self.v2.register(name, component_bytes, manifest)?;
                self.v1.unregister(name);
            }
        }
        self.routing.insert(name.to_string(), abi);
        Ok(())
    }

    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        match self.routing.get(name) {
            Some(ModuleAbi::V1Sync) => self.v1.instantiate(name),
            Some(ModuleAbi::V2Async) => self.v2.instantiate(name),
            None => Err(HostError::UnknownModule(name.to_string())),
        }
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        self.host_of(id).destroy(id)
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        self.host_of(id).init(id, config)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.host_of(id).dispatch(id, state, action, siblings)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.host_of(id).on_activated(id, state, siblings)
    }

    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        self.host_of(id).on_deactivated(id, state)
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        self.host_of(id).on_destroyed(id, state)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        self.host_of(id).actions(id)
    }
}
