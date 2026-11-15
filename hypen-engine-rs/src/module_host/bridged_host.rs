//! Browser [`ModuleHost`] that delegates to a JS-side shim.
//!
//! When the engine itself runs in wasm32 (browser via the `js` feature),
//! it cannot embed `wasmtime`. Instead it forwards every `ModuleHost`
//! method to a JS object — typically a small class that uses
//! `@bytecodealliance/jco` to instantiate WASM Components in the browser
//! and call their typed methods. The engine never sees module bytes; it
//! just speaks the trait.
//!
//! The contract the JS shim must satisfy is documented in the
//! `extern "C"` block below. A reference implementation is in
//! `wit-spikes/web-host/src/bridged-shim.mjs`.
//!
//! Capability grants ride on the manifest wire object passed to
//! `register` (see [`ManifestWire`]): `storage` lists the granted
//! scopes and `http` says whether `wasi:http` egress is granted. The
//! shim enforces both — for `http: false` it withholds its fetch-backed
//! `wasi:http` shim, mirroring the native hosts' link-time gate.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use super::{
    Effect, HostAction, HostError, LogLevel, ModuleHost, ModuleInstanceId, ModuleManifest,
    ReducerOutput, SiblingState, StorageScope, SubscribeRequest,
};

#[wasm_bindgen]
extern "C" {
    /// A JS-side object that loads and drives WASM Component modules. Must
    /// implement every method below; missing methods cause a JS TypeError at
    /// call time, which the bridge surfaces as [`HostError::Runtime`].
    pub type JsModuleHost;

    /// `manifest` is a plain JS object shaped like [`ManifestWire`]
    /// (`name`, `version`, `storage`, `reads`, `dispatches`, `http`).
    /// Capability gating is the shim's job: it must only expose the
    /// storage scopes listed in `storage`, and must withhold its
    /// `wasi:http` (fetch) shim when `http` is `false` — the browser
    /// equivalent of the native hosts' link-time `wasi:http` gate.
    #[wasm_bindgen(structural, method, js_name = "register", catch)]
    fn js_register(
        this: &JsModuleHost,
        name: &str,
        bytes: &[u8],
        manifest: JsValue,
    ) -> Result<(), JsValue>;

    #[wasm_bindgen(structural, method, js_name = "instantiate", catch)]
    fn js_instantiate(this: &JsModuleHost, name: &str) -> Result<f64, JsValue>;

    #[wasm_bindgen(structural, method, js_name = "destroy", catch)]
    fn js_destroy(this: &JsModuleHost, id: f64) -> Result<(), JsValue>;

    #[wasm_bindgen(structural, method, js_name = "init", catch)]
    fn js_init(this: &JsModuleHost, id: f64, config: Vec<u8>) -> Result<Vec<u8>, JsValue>;

    #[wasm_bindgen(structural, method, js_name = "dispatch", catch)]
    fn js_dispatch(
        this: &JsModuleHost,
        id: f64,
        state: Vec<u8>,
        action: JsValue,
        siblings: JsValue,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, js_name = "onActivated", catch)]
    fn js_on_activated(
        this: &JsModuleHost,
        id: f64,
        state: Vec<u8>,
        siblings: JsValue,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, js_name = "onDeactivated", catch)]
    fn js_on_deactivated(
        this: &JsModuleHost,
        id: f64,
        state: Vec<u8>,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, js_name = "onDestroyed", catch)]
    fn js_on_destroyed(this: &JsModuleHost, id: f64, state: Vec<u8>) -> Result<(), JsValue>;

    #[wasm_bindgen(structural, method, js_name = "actions", catch)]
    fn js_actions(this: &JsModuleHost, id: f64) -> Result<JsValue, JsValue>;
}

// ── wire-format types (serialized via serde-wasm-bindgen) ─────────────────

#[derive(Serialize)]
struct ManifestWire<'a> {
    name: &'a str,
    version: &'a str,
    storage: Vec<&'static str>,
    reads: &'a [String],
    dispatches: &'a [String],
    /// Whether `wasi:http` (outbound HTTP egress) is granted. The JS shim is
    /// expected to gate its `wasi:http` (fetch) shim on this — the browser
    /// analogue of the native hosts' link-time gate. Always present on the
    /// wire; a shim reading a manifest that lacks it (older engine) should
    /// treat absence as `true`, matching `ModuleManifest`'s serde default.
    http: bool,
}

fn scope_str(s: StorageScope) -> &'static str {
    match s {
        StorageScope::Local => "local",
        StorageScope::App => "app",
        StorageScope::Cloud => "cloud",
    }
}

#[derive(Serialize)]
struct ActionWire<'a> {
    name: &'a str,
    /// base64 is *not* used: serde-wasm-bindgen turns `Vec<u8>` into a JS
    /// `Uint8Array` directly. JS-side shims work with Uint8Arrays natively.
    payload: &'a [u8],
}

#[derive(Serialize)]
struct SiblingWire<'a> {
    module: &'a str,
    state: &'a [u8],
}

#[derive(Deserialize)]
struct ReducerOutputWire {
    #[serde(default)]
    state: Option<Vec<u8>>,
    #[serde(default)]
    effects: Vec<EffectWire>,
    #[serde(default)]
    emit: Vec<ActionWireOwned>,
    #[serde(default, rename = "crossDispatch")]
    cross_dispatch: Vec<CrossDispatchWire>,
    #[serde(default, rename = "subscribeRequests")]
    subscribe_requests: Vec<SubscribeWire>,
}

#[derive(Deserialize)]
struct ActionWireOwned {
    name: String,
    #[serde(default)]
    payload: Vec<u8>,
}

#[derive(Deserialize)]
struct CrossDispatchWire {
    module: String,
    action: ActionWireOwned,
}

/// A `hypen:engine/state.subscribe(module, path, on-change)` call the reducer
/// made during its dispatch, as captured by the JS shim host. The subscriber
/// is implicit (the module we just ran); the engine tags it when folding.
#[derive(Deserialize)]
struct SubscribeWire {
    module: String,
    #[serde(default)]
    path: String,
    #[serde(rename = "onChange")]
    on_change: String,
}

/// Effects on the wire match the WIT shape: `{tag: "log"|"navigate"|"delay", ...}`.
#[derive(Deserialize)]
#[serde(tag = "tag", rename_all = "lowercase")]
enum EffectWire {
    Log { level: String, message: String },
    Navigate { path: String },
    Delay { ms: u32, then: String },
}

fn level_from_str(s: &str) -> LogLevel {
    match s {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

fn js_err(e: JsValue) -> HostError {
    // Order: string -> Error.message -> Error.toString() -> JSON.stringify
    // -> debug-display. Real JS errors fall out as readable messages instead
    // of `{}` (which is what JSON.stringify gives for plain Error objects).
    if let Some(s) = e.as_string() {
        return HostError::Runtime(s);
    }
    if let Ok(msg) = js_sys::Reflect::get(&e, &JsValue::from_str("message")) {
        if let Some(s) = msg.as_string() {
            if !s.is_empty() {
                return HostError::Runtime(s);
            }
        }
    }
    if let Ok(to_string) = js_sys::Reflect::get(&e, &JsValue::from_str("toString")) {
        if let Ok(func) = to_string.dyn_into::<js_sys::Function>() {
            if let Ok(val) = func.call0(&e) {
                if let Some(s) = val.as_string() {
                    return HostError::Runtime(s);
                }
            }
        }
    }
    if let Ok(json) = js_sys::JSON::stringify(&e) {
        if let Some(s) = json.as_string() {
            return HostError::Runtime(s);
        }
    }
    HostError::Runtime(format!("{:?}", e))
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, HostError> {
    serde_wasm_bindgen::to_value(v).map_err(|e| HostError::Codec(e.to_string()))
}

fn id_to_f64(id: ModuleInstanceId) -> f64 {
    id.0 as f64
}

fn id_from_f64(v: f64) -> ModuleInstanceId {
    ModuleInstanceId(v as u64)
}

fn decode_output(raw: JsValue) -> Result<ReducerOutput, HostError> {
    let wire: ReducerOutputWire =
        serde_wasm_bindgen::from_value(raw).map_err(|e| HostError::Codec(e.to_string()))?;
    Ok(ReducerOutput {
        state: wire.state,
        effects: wire
            .effects
            .into_iter()
            .map(|e| match e {
                EffectWire::Log { level, message } => Effect::Log {
                    level: level_from_str(&level),
                    message,
                },
                EffectWire::Navigate { path } => Effect::Navigate(path),
                EffectWire::Delay { ms, then } => Effect::Delay { ms, then },
            })
            .collect(),
        emit: wire
            .emit
            .into_iter()
            .map(|a| HostAction { name: a.name, payload: a.payload })
            .collect(),
        cross_dispatch: wire
            .cross_dispatch
            .into_iter()
            .map(|c| (c.module, HostAction { name: c.action.name, payload: c.action.payload }))
            .collect(),
        subscribe_requests: wire
            .subscribe_requests
            .into_iter()
            .map(|s| SubscribeRequest {
                target: s.module,
                path: s.path,
                on_change: s.on_change,
            })
            .collect(),
    })
}

/// Browser-side `ModuleHost` that delegates to a JS shim.
///
/// `unsafe impl Send`: the `ModuleHost` trait requires `Send`, and `JsValue`
/// isn't normally `Send`. But wasm32 is single-threaded — there's nothing to
/// race with — so asserting `Send` on this target is sound. Same reasoning
/// as `wasm_bindgen::JsValue`'s own annotations.
pub struct BridgedHost {
    js: JsModuleHost,
}

unsafe impl Send for BridgedHost {}

impl BridgedHost {
    pub fn new(js: JsModuleHost) -> Self {
        Self { js }
    }
}

impl ModuleHost for BridgedHost {
    fn register(
        &mut self,
        name: &str,
        bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError> {
        let wire = ManifestWire {
            name: &manifest.name,
            version: &manifest.version,
            storage: manifest.storage.iter().copied().map(scope_str).collect(),
            reads: &manifest.reads,
            dispatches: &manifest.dispatches,
            http: manifest.grants_http(),
        };
        let manifest_js = to_js(&wire)?;
        self.js.js_register(name, bytes, manifest_js).map_err(js_err)
    }

    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        let id = self.js.js_instantiate(name).map_err(js_err)?;
        Ok(id_from_f64(id))
    }

    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        self.js.js_destroy(id_to_f64(id)).map_err(js_err)
    }

    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError> {
        self.js
            .js_init(id_to_f64(id), config.to_vec())
            .map_err(js_err)
    }

    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let action_js = to_js(&ActionWire {
            name: &action.name,
            payload: &action.payload,
        })?;
        let siblings_vec: Vec<SiblingWire<'_>> = siblings
            .iter()
            .map(|(m, s)| SiblingWire { module: m, state: s })
            .collect();
        let siblings_js = to_js(&siblings_vec)?;
        let raw = self
            .js
            .js_dispatch(id_to_f64(id), state.to_vec(), action_js, siblings_js)
            .map_err(js_err)?;
        decode_output(raw)
    }

    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let siblings_vec: Vec<SiblingWire<'_>> = siblings
            .iter()
            .map(|(m, s)| SiblingWire { module: m, state: s })
            .collect();
        let siblings_js = to_js(&siblings_vec)?;
        let raw = self
            .js
            .js_on_activated(id_to_f64(id), state.to_vec(), siblings_js)
            .map_err(js_err)?;
        decode_output(raw)
    }

    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        let raw = self
            .js
            .js_on_deactivated(id_to_f64(id), state.to_vec())
            .map_err(js_err)?;
        decode_output(raw)
    }

    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        self.js
            .js_on_destroyed(id_to_f64(id), state.to_vec())
            .map_err(js_err)
    }

    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        let raw = self.js.js_actions(id_to_f64(id)).map_err(js_err)?;
        serde_wasm_bindgen::from_value(raw).map_err(|e| HostError::Codec(e.to_string()))
    }
}
