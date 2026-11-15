//! UniFFI surface for the native module host — the mobile/desktop embedding
//! API. Kotlin (Android/JVM) and Swift (iOS/macOS) get a `HypenModuleHost`
//! object wrapping [`DualHost`], so platform host libraries speak the same
//! v0.1/v0.2 mux the dev runtime uses and ABI evolution never leaks into
//! their API.
//!
//! Conventions match the rest of this module: JSON strings in and out, so
//! the FFI surface stays stable while Rust types evolve. Binary component
//! bytes are the one exception (`Vec<u8>` maps to Kotlin `ByteArray` /
//! Swift `Data`).
//!
//! iOS note: construct with `{"interpreter": true}` — modules are compiled
//! to Pulley bytecode and interpreted, no executable pages, no JIT
//! entitlement needed.

use std::sync::Mutex;
use std::time::Duration;

use crate::module_host::{
    DualHost, Effect, ExecStrategy, HostAction, HostError, ModuleHost, ModuleInstanceId,
    ModuleLimits, ModuleManifest, ReducerOutput, SiblingState,
};

use super::HypenError;

impl From<HostError> for HypenError {
    fn from(e: HostError) -> Self {
        HypenError::ModuleHostError(e.to_string())
    }
}

/// The native module host, exported over FFI. One per app process is the
/// expected shape (all modules share its storage backend, like the runtime).
#[derive(uniffi::Object)]
pub struct HypenModuleHost {
    inner: Mutex<DualHost>,
}

fn bad(msg: impl std::fmt::Display) -> HypenError {
    HypenError::ModuleHostError(msg.to_string())
}

/// `{"maxMemoryBytes"?: u64, "maxCallMs"?: u64, "maxStorageValueBytes"?: u64,
///  "maxStorageBytes"?: u64, "interpreter"?: bool, "dataDir"?: string}` — all
/// optional (see [`ModuleLimits`] for the defaults).
fn parse_config(config_json: &str) -> Result<(ModuleLimits, ExecStrategy, Option<String>), HypenError> {
    let v: serde_json::Value = if config_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(config_json).map_err(|e| bad(format!("config: {e}")))?
    };
    let mut limits = ModuleLimits::default();
    if let Some(m) = v["maxMemoryBytes"].as_u64() {
        limits.max_memory_bytes = m as usize;
    }
    if let Some(ms) = v["maxCallMs"].as_u64() {
        limits.max_call = Duration::from_millis(ms);
    }
    if let Some(b) = v["maxStorageValueBytes"].as_u64() {
        limits.max_storage_value_bytes = b as usize;
    }
    if let Some(b) = v["maxStorageBytes"].as_u64() {
        limits.max_storage_bytes = b as usize;
    }
    let strategy = if v["interpreter"].as_bool().unwrap_or(false) {
        ExecStrategy::Interpreter
    } else {
        ExecStrategy::Jit
    };
    let data_dir = v["dataDir"].as_str().map(|s| s.to_string());
    Ok((limits, strategy, data_dir))
}

fn json_bytes_to_value(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap_or(serde_json::Value::Null)
}

fn action_to_json(a: &HostAction) -> serde_json::Value {
    serde_json::json!({ "name": a.name, "payload": json_bytes_to_value(&a.payload) })
}

/// ReducerOutput → the same camelCase wire shape the JS host uses, so every
/// SDK deserializes one format.
fn output_to_json(out: &ReducerOutput) -> serde_json::Value {
    let effects: Vec<serde_json::Value> = out
        .effects
        .iter()
        .map(|e| match e {
            Effect::Delay { ms, then } => {
                serde_json::json!({ "type": "delay", "ms": ms, "then": then })
            }
            Effect::Navigate(path) => serde_json::json!({ "type": "navigate", "path": path }),
            Effect::Log { level, message } => {
                serde_json::json!({ "type": "log", "level": format!("{level:?}").to_lowercase(), "message": message })
            }
        })
        .collect();
    serde_json::json!({
        "state": out.state.as_deref().map(json_bytes_to_value),
        "effects": effects,
        "emit": out.emit.iter().map(action_to_json).collect::<Vec<_>>(),
        "crossDispatch": out
            .cross_dispatch
            .iter()
            .map(|(module, a)| serde_json::json!({ "module": module, "action": action_to_json(a) }))
            .collect::<Vec<_>>(),
        "subscribeRequests": out
            .subscribe_requests
            .iter()
            .map(|s| serde_json::json!({ "module": s.target, "path": s.path, "onChange": s.on_change }))
            .collect::<Vec<_>>(),
    })
}

/// `{"moduleName": <state>, ...}` → sibling snapshots.
fn parse_siblings(siblings_json: &str) -> Result<Vec<SiblingState>, HypenError> {
    if siblings_json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let v: serde_json::Value =
        serde_json::from_str(siblings_json).map_err(|e| bad(format!("siblings: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| bad("siblings: expected a JSON object keyed by module name"))?;
    Ok(obj
        .iter()
        .map(|(name, state)| (name.clone(), serde_json::to_vec(state).unwrap_or_default()))
        .collect())
}

fn state_result(bytes: Vec<u8>) -> Result<String, HypenError> {
    String::from_utf8(bytes).map_err(|e| bad(format!("module returned non-UTF-8 state: {e}")))
}

#[uniffi::export]
impl HypenModuleHost {
    /// Default limits, JIT, in-memory storage.
    #[uniffi::constructor]
    pub fn new() -> Result<std::sync::Arc<Self>, HypenError> {
        Self::with_config(String::new())
    }

    /// Configured construction. `config_json`:
    /// `{"maxMemoryBytes"?, "maxCallMs"?, "interpreter"?, "dataDir"?}`.
    /// `interpreter: true` = Pulley (required on iOS); `dataDir` makes
    /// local/app storage persistent (JSON snapshots, like `--data-dir`).
    #[uniffi::constructor]
    pub fn with_config(config_json: String) -> Result<std::sync::Arc<Self>, HypenError> {
        let (limits, strategy, data_dir) = parse_config(&config_json)?;
        let host = DualHost::with_options(limits, strategy, data_dir.as_deref().map(std::path::Path::new))?;
        Ok(std::sync::Arc::new(Self { inner: Mutex::new(host) }))
    }

    /// Register a component. ABI (v0.1 sync / v0.2 async) is sniffed from
    /// the bytes. `manifest_json` has the same shape as an app.json module
    /// entry (`{"name", "storage"?, "reads"?, "dispatches"?, "http"?}`) and
    /// is deny-by-default: an omitted field — or an empty string — grants
    /// nothing beyond module-private `local` storage. Grant `app`/`cloud`
    /// storage and `"http": true` explicitly.
    pub fn register(
        &self,
        name: String,
        component: Vec<u8>,
        manifest_json: String,
    ) -> Result<(), HypenError> {
        let manifest: ModuleManifest = if manifest_json.trim().is_empty() {
            ModuleManifest { name: name.clone(), ..ModuleManifest::default() }
        } else {
            serde_json::from_str(&manifest_json).map_err(|e| bad(format!("manifest: {e}")))?
        };
        self.inner.lock().unwrap().register(&name, &component, manifest)?;
        Ok(())
    }

    pub fn instantiate(&self, name: String) -> Result<u64, HypenError> {
        Ok(self.inner.lock().unwrap().instantiate(&name)?.0)
    }

    pub fn destroy(&self, id: u64) -> Result<(), HypenError> {
        self.inner.lock().unwrap().destroy(ModuleInstanceId(id))?;
        Ok(())
    }

    /// Run the module's `init`; returns the initial state JSON.
    pub fn init(&self, id: u64, config_json: String) -> Result<String, HypenError> {
        let bytes = self
            .inner
            .lock()
            .unwrap()
            .init(ModuleInstanceId(id), config_json.as_bytes())?;
        state_result(bytes)
    }

    /// Dispatch an action; returns the ReducerOutput as JSON
    /// (`{"state", "effects", "emit", "crossDispatch", "subscribeRequests"}`
    /// — the same wire shape the JS host uses).
    pub fn dispatch(
        &self,
        id: u64,
        state_json: String,
        action_name: String,
        payload_json: String,
        siblings_json: String,
    ) -> Result<String, HypenError> {
        let siblings = parse_siblings(&siblings_json)?;
        let payload = if payload_json.trim().is_empty() {
            b"{}".to_vec()
        } else {
            payload_json.into_bytes()
        };
        let out = self.inner.lock().unwrap().dispatch(
            ModuleInstanceId(id),
            state_json.as_bytes(),
            HostAction::new(&action_name, payload),
            &siblings,
        )?;
        Ok(output_to_json(&out).to_string())
    }

    pub fn on_activated(
        &self,
        id: u64,
        state_json: String,
        siblings_json: String,
    ) -> Result<String, HypenError> {
        let siblings = parse_siblings(&siblings_json)?;
        let out = self.inner.lock().unwrap().on_activated(
            ModuleInstanceId(id),
            state_json.as_bytes(),
            &siblings,
        )?;
        Ok(output_to_json(&out).to_string())
    }

    pub fn on_deactivated(&self, id: u64, state_json: String) -> Result<String, HypenError> {
        let out = self
            .inner
            .lock()
            .unwrap()
            .on_deactivated(ModuleInstanceId(id), state_json.as_bytes())?;
        Ok(output_to_json(&out).to_string())
    }

    pub fn on_destroyed(&self, id: u64, state_json: String) -> Result<(), HypenError> {
        self.inner
            .lock()
            .unwrap()
            .on_destroyed(ModuleInstanceId(id), state_json.as_bytes())?;
        Ok(())
    }

    pub fn actions(&self, id: u64) -> Result<Vec<String>, HypenError> {
        Ok(self.inner.lock().unwrap().actions(ModuleInstanceId(id))?)
    }
}
