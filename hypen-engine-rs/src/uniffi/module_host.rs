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
    DualHost, Effect, ExecStrategy, HostAction, HostConfig, HostError, HttpRequest, InstanceStatus,
    ManifestGrant, ModuleHost, ModuleInstanceId, ModuleManifest, ReducerOutput, SiblingState,
    StorageScope,
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
///  "maxStorageBytes"?: u64, "interpreter"?: bool, "dataDir"?: string,
///  "cacheDir"?: string}` — all optional (see [`HostConfig`] for the
/// defaults). `cacheDir` turns on the on-disk compilation cache; it must be a
/// directory private to the app (see [`HostConfig::cache_dir`]).
fn parse_config(config_json: &str) -> Result<HostConfig, HypenError> {
    let v: serde_json::Value = if config_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(config_json).map_err(|e| bad(format!("config: {e}")))?
    };
    let mut config = HostConfig::default();
    if let Some(m) = v["maxMemoryBytes"].as_u64() {
        config.limits.max_memory_bytes = m as usize;
    }
    if let Some(ms) = v["maxCallMs"].as_u64() {
        config.limits.max_call = Duration::from_millis(ms);
    }
    if let Some(b) = v["maxStorageValueBytes"].as_u64() {
        config.limits.max_storage_value_bytes = b as usize;
    }
    if let Some(b) = v["maxStorageBytes"].as_u64() {
        config.limits.max_storage_bytes = b as usize;
    }
    if v["interpreter"].as_bool().unwrap_or(false) {
        config.strategy = ExecStrategy::Interpreter;
    }
    config.data_dir = v["dataDir"].as_str().map(std::path::PathBuf::from);
    config.cache_dir = v["cacheDir"].as_str().map(std::path::PathBuf::from);
    Ok(config)
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
            // Never in a reducer output (the engine creates it on admission);
            // rendered for completeness so the match stays exhaustive.
            Effect::Http(http) => serde_json::json!({
                "type": "http",
                "id": http.id.0,
                "request": http_request_to_json(&http.request),
                "then": http.then,
                "tag": http.tag,
            }),
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
        // Deferred HTTP requests the reducer queued (`hypen:http/deferred`),
        // already validated and allowlist-checked by the host. The embedder
        // performs each and dispatches `then` with the completion payload
        // documented in `wit/deps/hypen-http/http.wit`.
        "httpRequests": out
            .http_requests
            .iter()
            .map(|q| {
                let mut request = http_request_to_json(&q.request);
                request["then"] = serde_json::json!(q.then);
                request["tag"] = serde_json::json!(q.tag);
                request
            })
            .collect::<Vec<_>>(),
    })
}

/// `{ method, url, headers: [[name, value]], bodyBase64: string | null,
/// timeoutMs: number }`. The body is base64 because this surface speaks JSON
/// strings; `timeoutMs` is the effective budget (defaulted and clamped).
fn http_request_to_json(request: &HttpRequest) -> serde_json::Value {
    serde_json::json!({
        "method": request.method,
        "url": request.url,
        "headers": request.headers,
        "bodyBase64": request.body.as_deref().map(crate::module_host::base64_encode),
        "timeoutMs": request.effective_timeout_ms(),
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
    /// `{"maxMemoryBytes"?, "maxCallMs"?, "interpreter"?, "dataDir"?, "cacheDir"?}`.
    /// `interpreter: true` = Pulley (required on iOS); `dataDir` makes
    /// local/app storage persistent (JSON snapshots, like `--data-dir`);
    /// `cacheDir` keeps compiled modules across launches (like `--cache-dir`:
    /// opt-in, and the directory must be private to the app — its contents
    /// are executed).
    #[uniffi::constructor]
    pub fn with_config(config_json: String) -> Result<std::sync::Arc<Self>, HypenError> {
        let host = DualHost::with_config(&parse_config(&config_json)?)?;
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

    /// Whether the instance can still be called. `false` once a trap or
    /// timeout killed it (see [`death_reason`](Self::death_reason)) or it
    /// was destroyed. Answered from the host's bookkeeping — no module code
    /// runs.
    pub fn is_alive(&self, id: u64) -> bool {
        self.inner.lock().unwrap().instance_status(ModuleInstanceId(id)) == InstanceStatus::Live
    }

    /// What killed the instance (module, export, cause), or `None` if it is
    /// live, was destroyed, or never existed.
    pub fn death_reason(&self, id: u64) -> Option<String> {
        self.inner.lock().unwrap().death_reason(ModuleInstanceId(id))
    }

    /// The capabilities the module registered under `name` imports but was
    /// not granted, as JSON: `[{"import": "wasi:http/types@0.2.6", "grant":
    /// "http"}, {"import": "hypen:storage/cloud@0.1.0", "grant": "storage",
    /// "scope": "cloud"}]`. Non-empty exactly when `instantiate(name)` fails
    /// for missing grants; `[]` otherwise.
    pub fn denied_capabilities(&self, name: String) -> String {
        let denied = self.inner.lock().unwrap().denied_capabilities(&name);
        let list: Vec<serde_json::Value> = denied
            .iter()
            .map(|d| match d.grant {
                ManifestGrant::Storage(scope) => serde_json::json!({
                    "import": d.import,
                    "grant": "storage",
                    "scope": match scope {
                        StorageScope::Local => "local",
                        StorageScope::App => "app",
                        StorageScope::Cloud => "cloud",
                    },
                }),
                ManifestGrant::Http => serde_json::json!({ "import": d.import, "grant": "http" }),
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }
}
