//! A scriptable in-memory [`ModuleHost`] so the runtime can be unit-tested
//! without wasmtime or a real component.
//!
//! Every registered module is the same toy reducer over `{ "count": n }`:
//!
//! | action | effect |
//! |---|---|
//! | `increment` | `count += 1` |
//! | `delay` | emits `Delay { ms: 0, then: "increment" }` |
//! | `nav` | emits `Navigate("/next")` |
//! | `fail` | the reducer returns `Err` (the instance survives) |
//! | `crash` | the call traps; the instance is dead afterwards |
//!
//! `init(config)` seeds `count` from `config.start`. A module whose
//! registered bytes are `v2` additionally exports a `reset` action — enough
//! to tell a hot reload picked up new bytes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use hypen_engine::module_host::{
    DeniedCapability, Effect, HostAction, HostError, InstanceStatus, ManifestGrant, ModuleHost,
    ModuleInstanceId, ModuleManifest, ReducerOutput, SiblingState,
};
use serde_json::{json, Value};

#[derive(Default)]
pub struct FakeState {
    /// Registered component bytes by module name.
    registered: HashMap<String, Vec<u8>>,
    /// Live instance id → module name.
    live: HashMap<u64, String>,
    /// Instances that trapped (still occupying a slot until destroyed).
    dead: HashSet<u64>,
    next_id: u64,
    /// Module names whose `init` fails.
    pub fail_init: HashSet<String>,
    /// Module names whose next instance fails to instantiate.
    pub fail_instantiate: HashSet<String>,
    /// Module names whose last instantiation was refused for an ungranted
    /// `wasi:http` import (what `denied_capabilities` reports).
    denied_http: HashSet<String>,
    /// Whether the host answers `instance_status` from its own bookkeeping
    /// (like the real hosts) or leaves the trait's `Unknown` default.
    reports_status: bool,
    /// Instances on which `on_destroyed` ran, by module name, in order.
    pub destroyed_hooks: Vec<String>,
    /// Module names whose `on_destroyed` fails.
    pub fail_on_destroyed: HashSet<String>,
    /// How many guest calls (`init`, `dispatch`, lifecycle, `actions`) ran.
    pub guest_calls: usize,
}

/// The host handed to the engine.
pub struct FakeHost {
    state: Arc<Mutex<FakeState>>,
}

/// The test's window into the same state.
#[derive(Clone)]
pub struct FakeHandle {
    state: Arc<Mutex<FakeState>>,
}

pub fn fake_host() -> (Box<dyn ModuleHost>, FakeHandle) {
    let state = Arc::new(Mutex::new(FakeState::default()));
    (Box::new(FakeHost { state: Arc::clone(&state) }), FakeHandle { state })
}

impl FakeHandle {
    /// Instances that exist in the host (alive or dead-but-not-destroyed).
    pub fn instance_count(&self) -> usize {
        self.state.lock().unwrap().live.len()
    }

    pub fn instances_of(&self, module: &str) -> usize {
        self.state.lock().unwrap().live.values().filter(|m| *m == module).count()
    }

    pub fn fail_init(&self, module: &str, fail: bool) {
        let mut state = self.state.lock().unwrap();
        if fail {
            state.fail_init.insert(module.to_string());
        } else {
            state.fail_init.remove(module);
        }
    }

    pub fn fail_instantiate(&self, module: &str) {
        self.state.lock().unwrap().fail_instantiate.insert(module.to_string());
    }

    /// Answer `instance_status` like a real host from now on.
    pub fn report_status(&self) {
        self.state.lock().unwrap().reports_status = true;
    }

    pub fn fail_on_destroyed(&self, module: &str) {
        self.state.lock().unwrap().fail_on_destroyed.insert(module.to_string());
    }

    /// The modules whose `on_destroyed` hook ran, in order.
    pub fn destroyed_hooks(&self) -> Vec<String> {
        self.state.lock().unwrap().destroyed_hooks.clone()
    }

    pub fn guest_calls(&self) -> usize {
        self.state.lock().unwrap().guest_calls
    }

    /// The bytes last registered under `module`.
    pub fn registered(&self, module: &str) -> Option<Vec<u8>> {
        self.state.lock().unwrap().registered.get(module).cloned()
    }
}

impl FakeHost {
    /// The module an instance belongs to, or `DeadInstance`.
    fn alive(&self, id: ModuleInstanceId) -> Result<String, HostError> {
        let mut state = self.state.lock().unwrap();
        state.guest_calls += 1;
        if state.dead.contains(&id.0) {
            return Err(HostError::DeadInstance);
        }
        state.live.get(&id.0).cloned().ok_or(HostError::DeadInstance)
    }
}

impl ModuleHost for FakeHost {
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        _manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        self.state
            .lock()
            .unwrap()
            .registered
            .insert(name.to_string(), component_bytes.to_vec());
        Ok(())
    }

    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        let mut state = self.state.lock().unwrap();
        if !state.registered.contains_key(name) {
            return Err(HostError::UnknownModule(name.to_string()));
        }
        state.denied_http.remove(name);
        if state.fail_instantiate.remove(name) {
            state.denied_http.insert(name.to_string());
            return Err(HostError::Instantiate(
                "component imports instance `wasi:http/types@0.2.6`, but a matching \
                 implementation was not found in the linker"
                    .into(),
            ));
        }
        state.next_id += 1;
        let id = state.next_id;
        state.live.insert(id, name.to_string());
        Ok(ModuleInstanceId(id))
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        let mut state = self.state.lock().unwrap();
        state.dead.remove(&id.0);
        state.live.remove(&id.0).map(|_| ()).ok_or(HostError::DeadInstance)
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        let module = self.alive(id)?;
        if self.state.lock().unwrap().fail_init.contains(&module) {
            return Err(HostError::ModuleError("init refused".into()));
        }
        let config: Value = serde_json::from_slice(config).unwrap_or(Value::Null);
        let start = config.get("start").and_then(Value::as_i64).unwrap_or(0);
        Ok(json!({ "count": start }).to_string().into_bytes())
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        _siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.alive(id)?;
        let mut current: Value =
            serde_json::from_slice(state).map_err(|e| HostError::Codec(e.to_string()))?;
        let mut output = ReducerOutput::default();
        match action.name.as_str() {
            "increment" => {
                let count = current["count"].as_i64().unwrap_or(0) + 1;
                current["count"] = json!(count);
                output.state = Some(current.to_string().into_bytes());
            }
            "reset" => {
                current["count"] = json!(0);
                output.state = Some(current.to_string().into_bytes());
            }
            "delay" => output.effects.push(Effect::Delay { ms: 0, then: "increment".into() }),
            "nav" => output.effects.push(Effect::Navigate("/next".into())),
            "fail" => return Err(HostError::ModuleError("reducer said no".into())),
            "crash" => {
                self.state.lock().unwrap().dead.insert(id.0);
                return Err(HostError::Trap("wasm trap: unreachable".into()));
            }
            other => return Err(HostError::ModuleError(format!("unknown action: {other}"))),
        }
        Ok(output)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        _state: &[u8],
        _siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.alive(id)?;
        Ok(ReducerOutput::default())
    }

    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        _state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        self.alive(id)?;
        Ok(ReducerOutput::default())
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, _state: &[u8]) -> Result<(), HostError> {
        let module = self.alive(id)?;
        let mut state = self.state.lock().unwrap();
        state.destroyed_hooks.push(module.clone());
        if state.fail_on_destroyed.contains(&module) {
            return Err(HostError::ModuleError("on_destroyed refused".into()));
        }
        Ok(())
    }

    fn instance_status(&self, id: ModuleInstanceId) -> InstanceStatus {
        let state = self.state.lock().unwrap();
        if !state.reports_status {
            return InstanceStatus::Unknown;
        }
        if state.dead.contains(&id.0) {
            InstanceStatus::Dead { reason: Some("fake: export `dispatch` trapped".into()) }
        } else if state.live.contains_key(&id.0) {
            InstanceStatus::Live
        } else {
            InstanceStatus::Gone
        }
    }

    fn denied_capabilities(&self, name: &str) -> Vec<DeniedCapability> {
        if self.state.lock().unwrap().denied_http.contains(name) {
            vec![DeniedCapability {
                import: "wasi:http/types@0.2.6".into(),
                grant: ManifestGrant::Http,
            }]
        } else {
            Vec::new()
        }
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        let module = self.alive(id)?;
        let mut actions: Vec<String> =
            ["increment", "delay", "nav", "fail", "crash"].iter().map(|s| s.to_string()).collect();
        if self.state.lock().unwrap().registered.get(&module).map(Vec::as_slice) == Some(b"v2") {
            actions.push("reset".into());
        }
        Ok(actions)
    }
}
