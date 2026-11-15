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

/// Instance ids handed out for the async host carry this tag bit so calls
/// route back without a lookup table. Safe: slotmap's ffi encoding keeps the
/// top bit clear for any realistic instance count.
const ASYNC_ID_TAG: u64 = 1 << 63;

/// [`ModuleHost`] mux over both native hosts. `register` sniffs each
/// component's ABI; re-registering the same name re-sniffs (so hot reload
/// can change a module's ABI across a rebuild).
pub struct DualHost {
    v1: WasmtimeHost,
    v2: WasmtimeHostAsync,
    routing: HashMap<String, ModuleAbi>,
}

impl DualHost {
    /// Default limits, JIT execution, in-memory storage.
    pub fn new() -> Result<Self, HostError> {
        Self::with_options(ModuleLimits::default(), ExecStrategy::default(), None)
    }

    /// Full construction surface: limits + execution strategy (use
    /// [`ExecStrategy::Interpreter`] on JIT-forbidden platforms — iOS) +
    /// optional persistent-storage directory (one JSON snapshot per ABI
    /// host, since a v0.1 and v0.2 module are different components even
    /// when they model the same feature).
    pub fn with_options(
        limits: ModuleLimits,
        strategy: ExecStrategy,
        data_dir: Option<&Path>,
    ) -> Result<Self, HostError> {
        let mut v1 = WasmtimeHost::with_options(limits, strategy)?;
        let mut v2 = WasmtimeHostAsync::with_options(limits, strategy)?;
        if let Some(dir) = data_dir {
            v1.set_storage_path(dir.join("storage-v01.json"))?;
            v2.set_storage_path(dir.join("storage-v02.json"))?;
        }
        Ok(Self {
            v1,
            v2,
            routing: HashMap::new(),
        })
    }

    /// The two inner hosts, for host-specific knobs (e.g.
    /// [`WasmtimeHostAsync::set_virtual_clock`]).
    pub fn hosts_mut(&mut self) -> (&mut WasmtimeHost, &mut WasmtimeHostAsync) {
        (&mut self.v1, &mut self.v2)
    }

    fn host_for_id(&mut self, id: ModuleInstanceId) -> (&mut dyn ModuleHost, ModuleInstanceId) {
        if id.0 & ASYNC_ID_TAG != 0 {
            (&mut self.v2, ModuleInstanceId(id.0 & !ASYNC_ID_TAG))
        } else {
            (&mut self.v1, id)
        }
    }
}

impl ModuleHost for DualHost {
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        let abi = detect_abi(component_bytes);
        self.routing.insert(name.to_string(), abi);
        match abi {
            ModuleAbi::V1Sync => self.v1.register(name, component_bytes, manifest),
            ModuleAbi::V2Async => self.v2.register(name, component_bytes, manifest),
        }
    }

    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        match self.routing.get(name) {
            Some(ModuleAbi::V1Sync) => self.v1.instantiate(name),
            Some(ModuleAbi::V2Async) => self
                .v2
                .instantiate(name)
                .map(|id| ModuleInstanceId(id.0 | ASYNC_ID_TAG)),
            None => Err(HostError::UnknownModule(name.to_string())),
        }
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        let (host, id) = self.host_for_id(id);
        host.destroy(id)
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        let (host, id) = self.host_for_id(id);
        host.init(id, config)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let (host, id) = self.host_for_id(id);
        host.dispatch(id, state, action, siblings)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let (host, id) = self.host_for_id(id);
        host.on_activated(id, state, siblings)
    }

    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        let (host, id) = self.host_for_id(id);
        host.on_deactivated(id, state)
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        let (host, id) = self.host_for_id(id);
        host.on_destroyed(id, state)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        let (host, id) = self.host_for_id(id);
        host.actions(id)
    }
}
