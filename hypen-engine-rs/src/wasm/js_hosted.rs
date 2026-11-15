//! JS-facing wrapper around the native [`Engine`] for the bridged-host
//! workflow.
//!
//! The existing [`crate::wasm::js::WasmEngine`] is the legacy callback-based
//! surface — JS registers action handlers as closures, engine calls them.
//! This wrapper is for the *new* path: JS provides a [`BridgedHost`] (a
//! `JsModuleHost` object with jco-loaded WASM Component instances behind it),
//! and the engine drives module reducers across the wasm-bindgen boundary.
//!
//! Both can coexist; pick the wrapper that matches the SDK shape.

use wasm_bindgen::prelude::*;

use crate::dispatch::Action;
use crate::module_host::{BridgedHost, JsModuleHost, ModuleInstanceId};
use crate::Engine as RustEngine;

fn js_err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// `WasmHostedEngine` — exposes the native [`Engine`] (including its
/// module-host plumbing) to JS. Pair with a JS-side `JsModuleHost` that
/// drives jco-loaded module components.
#[wasm_bindgen]
pub struct WasmHostedEngine {
    inner: RustEngine,
}

#[wasm_bindgen]
impl WasmHostedEngine {
    #[allow(clippy::new_without_default)]
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { inner: RustEngine::new() }
    }

    /// Install the JS-side module host. After this, action dispatches whose
    /// names belong to a module-backed scope are routed through the bridge.
    #[wasm_bindgen(js_name = "setModuleHost")]
    pub fn set_module_host(&mut self, host: JsModuleHost) {
        self.inner.set_module_host(Box::new(BridgedHost::new(host)));
    }

    /// Convenience: register a module type + instantiate one instance + wire
    /// it into the engine in a single call. JS gets back the opaque instance
    /// id as an f64 (the same value JS-side `JsModuleHost` returned from
    /// `instantiate`).
    #[wasm_bindgen(js_name = "registerAndInstantiate")]
    pub fn register_and_instantiate(
        &mut self,
        scope: &str,
        component_bytes: &[u8],
        manifest: JsValue,
        actions: JsValue,
        config: &[u8],
    ) -> Result<f64, JsValue> {
        let manifest: crate::module_host::ModuleManifest =
            serde_wasm_bindgen::from_value(manifest)
                .map_err(|e| js_err(format!("manifest: {e}")))?;
        // `actions` is an optional override: pass an array to force a list,
        // or null/undefined to let the module describe itself via its
        // `actions` export (the normal path).
        let action_override: Option<Vec<String>> = if actions.is_undefined() || actions.is_null() {
            None
        } else {
            Some(
                serde_wasm_bindgen::from_value(actions)
                    .map_err(|e| js_err(format!("actions: {e}")))?,
            )
        };

        let host = self
            .inner
            .module_host_mut()
            .ok_or_else(|| js_err("no module host installed"))?;
        host.register(scope, component_bytes, manifest)
            .map_err(js_err)?;
        let id = host.instantiate(scope).map_err(js_err)?;
        let state_bytes = host.init(id, config).map_err(js_err)?;
        let initial_state: serde_json::Value =
            serde_json::from_slice(&state_bytes).map_err(js_err)?;
        let actions = match action_override {
            Some(a) => a,
            None => host.actions(id).map_err(js_err)?,
        };
        self.inner
            .register_module_instance(scope, id, actions, initial_state);
        Ok(id_to_f64(id))
    }

    /// Dispatch an action. The engine routes it; if the action is owned by a
    /// bridged module, the JS-side `dispatch` runs.
    ///
    /// `scope` is optional: pass the owning module's scope to disambiguate when
    /// several modules export the same action name. When omitted, the engine
    /// resolves a unique bare action name on its own.
    #[wasm_bindgen(js_name = "dispatchAction")]
    pub fn dispatch_action(
        &mut self,
        name: &str,
        payload: JsValue,
        scope: Option<String>,
    ) -> Result<(), JsValue> {
        let payload_v: serde_json::Value = if payload.is_undefined() || payload.is_null() {
            serde_json::Value::Null
        } else {
            serde_wasm_bindgen::from_value(payload).map_err(js_err)?
        };
        let qualified = match scope {
            Some(s) if !s.is_empty() => format!("{s}:{name}"),
            _ => name.to_string(),
        };
        self.inner
            .dispatch_action(Action::new(qualified).with_payload(payload_v))
            .map_err(js_err)
    }

    /// Read a named module's current state as a JS value (for assertions
    /// and debug UIs). Uses the json-compatible serializer so JS objects come
    /// out as plain `{k: v}` rather than `Map` instances.
    #[wasm_bindgen(js_name = "getModuleState")]
    pub fn get_module_state(&self, name: &str) -> JsValue {
        match self.inner.get_module_state(name) {
            Some(v) => v
                .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
                .unwrap_or(JsValue::NULL),
            None => JsValue::NULL,
        }
    }
}

use serde::Serialize;

fn id_to_f64(id: ModuleInstanceId) -> f64 {
    id.0 as f64
}
