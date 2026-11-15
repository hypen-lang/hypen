//! Hosted (WASM-component) modules on [`WasmEngine`] — the
//! `module-loader-bridged` feature, server builds only.
//!
//! `WasmEngine` composes [`crate::hosted::HostedModules`] with its
//! `EngineCore` the way the native `Engine` does, so one engine runs both
//! kinds of module side by side:
//!
//! - **in-process modules** — JS action handlers registered with `onAction`
//!   under the scope's wire names, state written with `updateState*`;
//! - **hosted modules** — reducers inside a JS module host (a
//!   `@hypen-space/module-host` `JsModuleHost`, driven through
//!   [`BridgedHost`]), registered with `registerHostedModule`.
//!
//! Routing, the cascade, the ACLs, subscriptions and the failure report are
//! the Rust subsystem's; this file only adapts the JS side to it
//! ([`JsClosures`], [`JsPatchOutlet`]) and marshals values and errors.
//!
//! # Errors
//!
//! Every method here throws a JS `Error` carrying `type: "moduleError"`, a
//! stable `code`, and — depending on the code — `scope`, `stage`, `hostCode`
//! and `report` (the structured cascade report). See [`Thrown`].
//!
//! # Re-entrancy
//!
//! The engine calls into JS — the module host, action handlers, the effect
//! handler, the render callback — while a `&mut self` method is running, and
//! wasm-bindgen refuses any call back into the same `WasmEngine` from inside
//! one (it throws at the re-entrant caller; nothing in the engine runs and
//! nothing is corrupted). A callback that lets that exception escape is
//! reported like any other failing callback; [`describe_js_error`] rewrites
//! the message into one that names the cause. JS code that needs the engine
//! from inside a callback defers the call (`queueMicrotask`).

use std::collections::HashMap;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::js::{deliver_routed_action, emit_patches_to, structured_error, WasmEngine};
use super::shared::NodeIdIndex;
use crate::dispatch::Action;
use crate::engine_core::EngineCore;
use crate::error::EngineError;
use crate::hosted::{
    ClosureActions, EngineCtx, HostedModules, HttpCompletionError, HttpDelivery, LifecycleHook,
    ModuleGrants, PatchOutlet, ScopeName,
};
use crate::module_host::{
    describe_js_error, BridgedHost, Effect, HostError, HttpEffect, HttpFailure, HttpFailureKind,
    HttpOutcome, HttpRequestId, HttpResponse, HttpUrl, JsModuleHost, ModuleInstanceId,
    ModuleManifest,
};
use crate::reconcile::Patch;

/// The methods a JS module host must have (see `bridged_host.rs`).
const HOST_METHODS: [&str; 9] = [
    "register",
    "instantiate",
    "destroy",
    "init",
    "dispatch",
    "onActivated",
    "onDeactivated",
    "onDestroyed",
    "actions",
];

/// What the binding remembers about a hosted scope besides what the
/// subsystem holds: how to reach its component in the host again (reload)
/// and what to tell JS about it.
pub(super) struct HostedRecord {
    /// The name the component is registered under in the JS module host.
    component: String,
    manifest: ModuleManifest,
}

// ── errors ──────────────────────────────────────────────────────────────────

/// An error thrown to JS: an `Error` with `type: "moduleError"` and a stable
/// `code`.
///
/// | `code` | meaning | extra fields |
/// |---|---|---|
/// | `invalidArgument` | an argument has the wrong shape (host object, manifest, config, payload, actions, handler) | |
/// | `invalidName` | the scope or an action name cannot be wired | `scope` |
/// | `noModuleHost` | no module host installed (`setModuleHost`) | |
/// | `modulesRegistered` | the host cannot be replaced while hosted modules are wired | |
/// | `alreadyRegistered` | the scope already hosts a module | `scope` |
/// | `scopeInUse` | the scope is an in-process module's | `scope` |
/// | `unknownModule` | no hosted module under the scope | `scope` |
/// | `actionNotAccepted` | the hosted module does not accept that action | `scope` |
/// | `hostError` | the module host failed outside a cascade | `scope`, `stage`, `hostCode` |
/// | `invalidState` | `init` returned something that is not a JSON object | `scope`, `stage` |
/// | `moduleCallFailed` | the root call of a cascade failed; nothing was applied | `scope`, `report` |
/// | `cascadeIncomplete` | the root ran, some follow-ups failed; applied state stands | `scope`, `report` |
/// | `unknownHttpRequest` | `completeHttpRequest` with an id that is not in flight (never issued, or already completed) | |
/// | `moduleError` | anything else the engine refused | `scope` |
struct Thrown {
    code: &'static str,
    message: String,
    scope: Option<String>,
    /// `register` / `instantiate` / `init` / `actions` / `onDestroyed` /
    /// `destroy`: the host call that failed.
    stage: Option<&'static str>,
    /// [`HostError::code`] of the host failure.
    host_code: Option<&'static str>,
    report: Option<serde_json::Value>,
}

impl Thrown {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            scope: None,
            stage: None,
            host_code: None,
            report: None,
        }
    }

    fn scope(mut self, scope: &str) -> Self {
        self.scope = Some(scope.to_string());
        self
    }

    /// A module-host call that failed outside a cascade.
    fn host(scope: &str, stage: &'static str, error: &HostError) -> Self {
        let mut thrown = Self::new(
            "hostError",
            format!("[{scope}] the module host failed at '{stage}': {error}"),
        )
        .scope(scope);
        thrown.stage = Some(stage);
        thrown.host_code = Some(error.code());
        thrown
    }
}

impl From<Thrown> for JsValue {
    fn from(thrown: Thrown) -> JsValue {
        let error = js_sys::Error::new(&thrown.message);
        error.set_name("HypenModuleError");
        let set = |key: &str, value: JsValue| {
            let _ = js_sys::Reflect::set(&error, &JsValue::from_str(key), &value);
        };
        set("type", JsValue::from_str("moduleError"));
        set("code", JsValue::from_str(thrown.code));
        if let Some(scope) = &thrown.scope {
            set("scope", JsValue::from_str(scope));
        }
        if let Some(stage) = thrown.stage {
            set("stage", JsValue::from_str(stage));
        }
        if let Some(host_code) = thrown.host_code {
            set("hostCode", JsValue::from_str(host_code));
        }
        if let Some(report) = &thrown.report {
            set("report", plain(report));
        }
        error.into()
    }
}

/// A serde value as plain JS objects and arrays (never `Map`s).
fn plain<T: Serialize>(value: &T) -> JsValue {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

fn invalid(what: &str, why: impl std::fmt::Display) -> Thrown {
    Thrown::new("invalidArgument", format!("{what}: {why}"))
}

// ── argument marshalling ────────────────────────────────────────────────────

/// A JSON value from a JS argument; `undefined` / `null` are `null`.
fn json_arg(what: &str, value: JsValue) -> Result<serde_json::Value, Thrown> {
    if value.is_undefined() || value.is_null() {
        return Ok(serde_json::Value::Null);
    }
    serde_wasm_bindgen::from_value(value).map_err(|e| invalid(what, format!("not JSON ({e})")))
}

/// The `config` handed to a module's `init`: a `Uint8Array` is passed as is,
/// anything else is JSON-encoded, nothing at all is `{}`.
fn config_bytes(config: JsValue) -> Result<Vec<u8>, Thrown> {
    if config.is_undefined() || config.is_null() {
        return Ok(b"{}".to_vec());
    }
    if let Some(bytes) = config.dyn_ref::<js_sys::Uint8Array>() {
        return Ok(bytes.to_vec());
    }
    let value = json_arg("config", config)?;
    serde_json::to_vec(&value).map_err(|e| invalid("config", e))
}

/// A manifest object (`{ name?, version?, storage?, reads?, dispatches?,
/// http?, httpHosts? }`); nothing at all is the deny-everything default. A
/// malformed `httpHosts` pattern is an `invalidArgument` naming it.
fn manifest_arg(manifest: JsValue) -> Result<Option<ModuleManifest>, Thrown> {
    if manifest.is_undefined() || manifest.is_null() {
        return Ok(None);
    }
    if !manifest.is_object() || js_sys::Array::is_array(&manifest) {
        return Err(invalid("manifest", "expected an object"));
    }
    serde_wasm_bindgen::from_value(manifest)
        .map(Some)
        .map_err(|e| invalid("manifest", e))
}

/// An optional action-list override; nothing at all means "ask the module".
fn actions_arg(actions: JsValue) -> Result<Option<Vec<String>>, Thrown> {
    if actions.is_undefined() || actions.is_null() {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(actions)
        .map(Some)
        .map_err(|e| invalid("actions", format!("expected an array of strings ({e})")))
}

// ── the JS side as the subsystem's collaborators ────────────────────────────

/// The JS action handlers as the hosted subsystem's in-process handlers.
struct JsClosures<'a> {
    handlers: &'a HashMap<String, js_sys::Function>,
    data_source_handler: Option<&'a js_sys::Function>,
}

impl ClosureActions for JsClosures<'_> {
    fn has_handler(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }

    fn dispatch_ui(&self, core: &EngineCore, action: Action) -> Result<(), EngineError> {
        deliver_routed_action(self.handlers, self.data_source_handler, core, action);
        Ok(())
    }

    fn deliver(&self, action: &Action) -> Result<(), String> {
        let handler = self
            .handlers
            .get(&action.name)
            .ok_or_else(|| "no handler is registered any more".to_string())?;
        let action_js = action
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| format!("the action could not be handed to JS: {e}"))?;
        handler
            .call1(&JsValue::NULL, &action_js)
            .map(|_| ())
            .map_err(|thrown| describe_js_error(&thrown))
    }
}

/// The JS render callback as the hosted subsystem's patch outlet.
struct JsPatchOutlet<'a> {
    index: &'a mut NodeIdIndex,
    callback: Option<&'a js_sys::Function>,
}

impl PatchOutlet for JsPatchOutlet<'_> {
    fn emit(&mut self, core: &EngineCore, patches: Vec<Patch>) {
        emit_patches_to(self.index, self.callback, core, patches);
    }
}

/// A JS effect callback behind the subsystem's `Send + Sync` handler type.
///
/// `unsafe impl`: a `js_sys::Function` is not `Send`/`Sync`, but this type
/// only exists on wasm32, which is single-threaded — the same reasoning as
/// `BridgedHost`.
struct JsEffectHandler(js_sys::Function);

unsafe impl Send for JsEffectHandler {}
unsafe impl Sync for JsEffectHandler {}

impl JsEffectHandler {
    fn call(&self, scope: &str, effect: &Effect) {
        let effect_js = match effect {
            Effect::Navigate(path) => plain(&serde_json::json!({ "type": "navigate", "path": path })),
            Effect::Delay { ms, then } => {
                plain(&serde_json::json!({ "type": "delay", "ms": ms, "then": then }))
            }
            Effect::Http(http) => http_effect_js(http),
            // Handled engine-side; never forwarded.
            Effect::Log { .. } => return,
        };
        if let Err(thrown) = self.0.call2(&JsValue::NULL, &JsValue::from_str(scope), &effect_js) {
            crate::logger::log(
                crate::logger::LogLevel::Warn,
                crate::logger::LogScope::Engine,
                &format!(
                    "[{scope}] the module effect handler threw: {}",
                    describe_js_error(&thrown)
                ),
            );
        }
    }
}

/// An `Effect::Http` as the JS effect handler receives it:
///
/// ```text
/// { type: "http", id: number,
///   request: { method: string, url: string, headers: [string, string][],
///              body: Uint8Array | null, timeoutMs: number },
///   then: string, tag: string | null,
///   allowedHosts: string[] | null }
/// ```
///
/// `timeoutMs` is the effective budget (defaulted and clamped).
/// `allowedHosts` is the module's `httpHosts` allowlist (`null` = any host):
/// the handler must not follow a redirect to a host outside it —
/// `httpRedirectAllowed(id, url)` answers that per hop. The body is the one
/// copy made of it (into the `Uint8Array`).
fn http_effect_js(http: &HttpEffect) -> JsValue {
    let set = |object: &js_sys::Object, key: &str, value: JsValue| {
        // Setting a property on a fresh plain object cannot fail.
        let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), &value);
    };
    let text = |value: &Option<String>| value.as_deref().map_or(JsValue::NULL, JsValue::from_str);

    let request = js_sys::Object::new();
    set(&request, "method", JsValue::from_str(&http.request.method));
    set(&request, "url", JsValue::from_str(&http.request.url));
    set(&request, "headers", plain(&http.request.headers));
    let body = http
        .request
        .body
        .as_deref()
        .map_or(JsValue::NULL, |bytes| js_sys::Uint8Array::from(bytes).into());
    set(&request, "body", body);
    set(
        &request,
        "timeoutMs",
        JsValue::from_f64(f64::from(http.request.effective_timeout_ms())),
    );

    let effect = js_sys::Object::new();
    set(&effect, "type", JsValue::from_str("http"));
    // Ids are issued sequentially from 1: exact as a JS number.
    set(&effect, "id", JsValue::from_f64(http.id.0 as f64));
    set(&effect, "request", request.into());
    set(&effect, "then", JsValue::from_str(&http.then));
    set(&effect, "tag", text(&http.tag));
    let allowed: Option<Vec<String>> = http
        .grant
        .patterns()
        .map(|patterns| patterns.iter().map(ToString::to_string).collect());
    set(&effect, "allowedHosts", plain(&allowed));
    effect.into()
}

/// The id of a request in flight, from the number the effect carried.
fn http_request_id(id: f64) -> Result<HttpRequestId, Thrown> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if id.is_finite() && id >= 0.0 && id.fract() == 0.0 && id <= MAX_SAFE_INTEGER {
        Ok(HttpRequestId(id as u64))
    } else {
        Err(invalid("id", "expected the `id` of an http effect"))
    }
}

/// A `completeHttpRequest` result:
/// `{ ok: true, status, headers?, body? }` or
/// `{ ok: false, error: { kind, message? } }`.
///
/// `headers` is a plain object (`{ name: value }`, a value may be a string
/// or an array of strings) or an array of `[name, value]` pairs — both
/// `Object.fromEntries(response.headers)` and `[...response.headers]` work.
/// `body` is a `Uint8Array`, an `ArrayBuffer` or a string (sent as its UTF-8
/// bytes); absent or `null` is an empty body.
fn http_outcome_arg(result: &JsValue) -> Result<HttpOutcome, Thrown> {
    let bad = |why: &str| invalid("result", why);
    if !result.is_object() {
        return Err(bad("expected an object with a boolean `ok`"));
    }
    let get = |object: &JsValue, key: &str| {
        js_sys::Reflect::get(object, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
    };
    let missing = |value: &JsValue| value.is_undefined() || value.is_null();

    match get(result, "ok").as_bool() {
        None => Err(bad("`ok` must be true or false")),
        Some(false) => {
            let error = get(result, "error");
            let kind = get(&error, "kind").as_string().unwrap_or_default();
            let Some(kind) = HttpFailureKind::from_wire(&kind) else {
                return Err(bad(
                    "`error.kind` must be one of \"network\", \"timeout\", \"denied\", \
                     \"too-large\", \"invalid-response\"",
                ));
            };
            let message = get(&error, "message").as_string().unwrap_or_default();
            Ok(HttpOutcome::Failure(HttpFailure::new(kind, message)))
        }
        Some(true) => {
            let status = get(result, "status")
                .as_f64()
                .filter(|s| s.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(s))
                .ok_or_else(|| bad("`status` must be an integer HTTP status"))?
                as u16;

            let headers_js = get(result, "headers");
            let mut headers: Vec<(String, String)> = Vec::new();
            let bad_headers = || {
                bad("`headers` must be an object of strings or an array of [name, value] pairs")
            };
            if missing(&headers_js) {
                // No headers.
            } else if js_sys::Array::is_array(&headers_js) {
                for pair in js_sys::Array::from(&headers_js).iter() {
                    let pair: (String, String) =
                        serde_wasm_bindgen::from_value(pair).map_err(|_| bad_headers())?;
                    headers.push(pair);
                }
            } else if headers_js.is_object() {
                let entries = js_sys::Object::entries(headers_js.unchecked_ref());
                for entry in entries.iter() {
                    let entry = js_sys::Array::from(&entry);
                    let name = entry.get(0).as_string().ok_or_else(bad_headers)?;
                    let value = entry.get(1);
                    if let Some(value) = value.as_string() {
                        headers.push((name, value));
                    } else if js_sys::Array::is_array(&value) {
                        for value in js_sys::Array::from(&value).iter() {
                            let value = value.as_string().ok_or_else(bad_headers)?;
                            headers.push((name.clone(), value));
                        }
                    } else {
                        return Err(bad_headers());
                    }
                }
            } else {
                return Err(bad_headers());
            }

            let body_js = get(result, "body");
            let body = if missing(&body_js) {
                Vec::new()
            } else if let Some(text) = body_js.as_string() {
                text.into_bytes()
            } else if body_js.is_instance_of::<js_sys::Uint8Array>() {
                js_sys::Uint8Array::from(body_js).to_vec()
            } else if body_js.is_instance_of::<js_sys::ArrayBuffer>() {
                js_sys::Uint8Array::new(&body_js).to_vec()
            } else {
                return Err(bad("`body` must be a Uint8Array, an ArrayBuffer or a string"));
            };
            Ok(HttpOutcome::Response(HttpResponse {
                status,
                headers,
                body,
            }))
        }
    }
}

// ── internals shared with `js.rs` ───────────────────────────────────────────

impl WasmEngine {
    /// Run `f` with the hosted subsystem and the engine parts it works on.
    pub(super) fn with_hosted<R>(
        &mut self,
        f: impl FnOnce(&mut HostedModules, &mut EngineCtx<'_>) -> R,
    ) -> R {
        let closures = JsClosures {
            handlers: &self.action_handlers,
            data_source_handler: self.data_source_action_handler.as_ref(),
        };
        let mut outlet = JsPatchOutlet {
            index: &mut self.node_id_index,
            callback: self.patch_callback.as_ref(),
        };
        let mut ctx = EngineCtx {
            core: &mut self.core,
            closures: &closures,
            patches: &mut outlet,
        };
        f(&mut self.hosted, &mut ctx)
    }

    /// Run a call that may start a cascade and turn its failure into the
    /// error to throw: with the cascade's report when one ran (under `scope`,
    /// or the scope the cascade's root ran in), else as `otherwise`
    /// classifies it.
    fn cascade_call(
        &mut self,
        scope: Option<&str>,
        call: impl FnOnce(&mut HostedModules, &mut EngineCtx<'_>) -> Result<(), EngineError>,
        otherwise: impl FnOnce(EngineError) -> JsValue,
    ) -> Result<(), JsValue> {
        let before = self.hosted.cascades_concluded();
        let Err(error) = self.with_hosted(call) else {
            return Ok(());
        };
        if self.hosted.cascades_concluded() == before {
            return Err(otherwise(error));
        }
        let Some(report) = self.hosted.last_report() else {
            return Err(otherwise(error));
        };
        let code = match report.root_failure() {
            Some(_) => "moduleCallFailed",
            None => "cascadeIncomplete",
        };
        let mut thrown =
            Thrown::new(code, error.to_string()).scope(scope.unwrap_or(report.root().scope()));
        thrown.report = Some(report.to_json());
        Err(thrown.into())
    }

    /// `dispatchAction` once a hosted module is wired: route, then the owning
    /// hosted module or the JS handlers. A routing refusal is the same
    /// `actionError` as without hosted modules; a failing module call throws
    /// the module error with its report.
    pub(super) fn dispatch_ui_with_hosted(&mut self, action: Action) -> Result<(), JsValue> {
        self.cascade_call(
            None,
            |hosted, ctx| hosted.dispatch_ui_action(ctx, action),
            |error| structured_error("actionError", &error.to_string()),
        )
    }

    /// Tear a hosted scope down completely: `on_destroyed`, everything the
    /// engine holds for it, then the host-side instance. `Ok(false)` when the
    /// scope hosts nothing. A failing hook is returned after the teardown.
    pub(super) fn destroy_hosted(&mut self, scope: &str) -> Result<bool, JsValue> {
        let Some(id) = self.hosted.instance_id(scope) else {
            return Ok(false);
        };
        let scope = scope.to_lowercase();
        let hook = self.with_hosted(|hosted, ctx| hosted.destroy(ctx, &scope));
        self.hosted_records.remove(&scope);
        let released = match self.hosted.host_mut() {
            Some(host) => host.destroy(id),
            None => Ok(()),
        };
        if let Err(error) = hook {
            let mut thrown = Thrown::new("hostError", error.to_string()).scope(&scope);
            thrown.stage = Some("onDestroyed");
            return Err(thrown.into());
        }
        released.map_err(|error| Thrown::host(&scope, "destroy", &error))?;
        Ok(true)
    }

    /// Release every hosted instance in the module host and forget them all
    /// (the engine core is being replaced). Best effort: a host that fails to
    /// destroy an instance does not stop the reset.
    pub(super) fn release_hosted_instances(&mut self) {
        let ids = self.hosted.clear();
        self.hosted_records.clear();
        if let Some(host) = self.hosted.host_mut() {
            for id in ids {
                let _ = host.destroy(id);
            }
        }
    }

    /// `{ scope, component, instanceId, actions, wildcard }` for a hosted
    /// scope, as returned by registration and listed by `hostedModules`.
    fn describe_hosted(&self) -> Vec<serde_json::Value> {
        self.hosted
            .describe()
            .into_iter()
            .map(|info| {
                let component = self
                    .hosted_records
                    .get(&info.scope)
                    .map(|record| record.component.as_str());
                let id = self.hosted.instance_id(&info.scope);
                serde_json::json!({
                    "scope": info.scope,
                    "component": component,
                    "instanceId": id.map(|id| id.0),
                    "actions": info.actions,
                    "wildcard": info.wildcard,
                })
            })
            .collect()
    }

    fn describe_one(&self, scope: &str) -> JsValue {
        self.describe_hosted()
            .into_iter()
            .find(|module| module["scope"] == scope)
            .map_or(JsValue::NULL, |module| plain(&module))
    }

    /// Ask the module for its action list unless the caller forced one.
    fn hosted_actions(
        &mut self,
        scope: &str,
        id: ModuleInstanceId,
        forced: Option<Vec<String>>,
    ) -> Result<Vec<String>, Thrown> {
        if let Some(actions) = forced {
            return Ok(actions);
        }
        let host = self
            .hosted
            .host_mut()
            .ok_or_else(|| Thrown::new("noModuleHost", "no module host installed"))?;
        host.actions(id)
            .map_err(|error| Thrown::host(scope, "actions", &error))
    }

    /// The engine refused to wire an instance: say why with the right code.
    fn wiring_error(scope: &str, error: EngineError) -> Thrown {
        let code = match &error {
            EngineError::StateError(_) => "invalidState",
            EngineError::ModuleError(message) if message.contains("invalid ") => "invalidName",
            _ => "moduleError",
        };
        Thrown::new(code, error.to_string()).scope(scope)
    }
}

// ── the JS surface ──────────────────────────────────────────────────────────

#[wasm_bindgen]
impl WasmEngine {
    /// Install the JS module host that runs hosted modules: an object with
    /// the `JsModuleHost` methods (`register`, `instantiate`, `destroy`,
    /// `init`, `dispatch`, `onActivated`, `onDeactivated`, `onDestroyed`,
    /// `actions`) — `new JsModuleHost()` from `@hypen-space/module-host`.
    ///
    /// Throws `invalidArgument` when a method is missing, and
    /// `modulesRegistered` when hosted modules are wired (their instances
    /// live in the current host).
    #[wasm_bindgen(js_name = setModuleHost)]
    pub fn set_module_host(&mut self, host: JsValue) -> Result<(), JsValue> {
        if !host.is_object() {
            return Err(invalid("host", "expected a JsModuleHost object").into());
        }
        let missing: Vec<&str> = HOST_METHODS
            .into_iter()
            .filter(|method| {
                !js_sys::Reflect::get(&host, &JsValue::from_str(method))
                    .is_ok_and(|value| value.is_function())
            })
            .collect();
        if !missing.is_empty() {
            return Err(invalid(
                "host",
                format!("missing JsModuleHost method(s): {}", missing.join(", ")),
            )
            .into());
        }
        if !self.hosted.is_empty() {
            return Err(Thrown::new(
                "modulesRegistered",
                "the module host cannot be replaced while hosted modules are registered; \
                 destroy them first",
            )
            .into());
        }
        let host: JsModuleHost = host.unchecked_into();
        self.hosted.set_host(Box::new(BridgedHost::new(host)));
        Ok(())
    }

    /// Whether a module host is installed.
    #[wasm_bindgen(js_name = hasModuleHost)]
    pub fn has_module_host(&mut self) -> bool {
        self.hosted.host_mut().is_some()
    }

    /// Instantiate a hosted module and wire it into the engine under `scope`.
    ///
    /// - `component`: the name the component is registered (and, for a
    ///   `JsModuleHost`, `prepare()`d) under in the module host. Defaults to
    ///   `scope` as given.
    /// - `manifest`: `{ name?, version?, storage?, reads?, dispatches?,
    ///   http? }`. `reads` / `dispatches` become the scope's grants, enforced
    ///   by the engine; they may name in-process modules. Omitted = no
    ///   cross-module access. The whole manifest is handed to the host's
    ///   `register` (with empty bytes: the component must already be there).
    /// - `config`: the module's `init` config — JSON-encoded, or a
    ///   `Uint8Array` passed as is. Omitted = `{}`.
    /// - `actions`: an action-list override; omitted = the module's own
    ///   `actions` export.
    ///
    /// Runs `register` → `instantiate` → `init` → `actions` in the host and
    /// seeds the scope's state from what `init` returned. Returns
    /// `{ scope, component, instanceId, actions, wildcard }`. On any failure
    /// nothing stays wired and the instance is destroyed again.
    #[wasm_bindgen(js_name = registerHostedModule)]
    pub fn register_hosted_module(
        &mut self,
        scope: &str,
        component: Option<String>,
        manifest: JsValue,
        config: JsValue,
        actions: JsValue,
    ) -> Result<JsValue, JsValue> {
        let scope_name = ScopeName::parse(scope)
            .map_err(|e| Thrown::new("invalidName", e.to_string()).scope(scope))?;
        let scope = scope_name.as_str();
        if self.hosted.instance_id(scope).is_some() {
            return Err(Thrown::new(
                "alreadyRegistered",
                format!(
                    "[{scope}] a hosted module is already registered under this scope; \
                     destroy it first, or reload it"
                ),
            )
            .scope(scope)
            .into());
        }
        // (A scope a rendered template merely mentions is a placeholder, not
        // a module.)
        if self.core.modules.contains_key(scope) && !self.core.placeholder_scopes.contains(scope) {
            return Err(Thrown::new(
                "scopeInUse",
                format!("[{scope}] an in-process module is registered under this scope"),
            )
            .scope(scope)
            .into());
        }
        let component = component
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| scope_name.as_str().to_string());
        let mut manifest = manifest_arg(manifest)?.unwrap_or_default();
        if manifest.name.is_empty() {
            manifest.name.clone_from(&component);
        }
        let config = config_bytes(config)?;
        let forced_actions = actions_arg(actions)?;
        let grants = ModuleGrants::from(&manifest);

        let host = self
            .hosted
            .host_mut()
            .ok_or_else(|| Thrown::new("noModuleHost", "no module host installed"))?;
        host.register(&component, &[], manifest.clone())
            .map_err(|error| Thrown::host(scope, "register", &error))?;
        let id = host
            .instantiate(&component)
            .map_err(|error| Thrown::host(scope, "instantiate", &error))?;

        // From here on a failure must not leak the instance.
        let wired = (|| {
            let host = self
                .hosted
                .host_mut()
                .ok_or_else(|| Thrown::new("noModuleHost", "no module host installed"))?;
            let state = host
                .init(id, &config)
                .map_err(|error| Thrown::host(scope, "init", &error))?;
            let state: serde_json::Value = serde_json::from_slice(&state).map_err(|e| {
                let mut thrown = Thrown::new(
                    "invalidState",
                    format!("[{scope}] the module's init returned state that is not JSON: {e}"),
                )
                .scope(scope);
                thrown.stage = Some("init");
                thrown
            })?;
            let actions = self.hosted_actions(scope, id, forced_actions)?;
            self.with_hosted(|hosted, ctx| hosted.register(ctx, scope, id, actions, grants, state))
                .map_err(|error| Self::wiring_error(scope, error))
        })();
        if let Err(thrown) = wired {
            if let Some(host) = self.hosted.host_mut() {
                let _ = host.destroy(id);
            }
            return Err(thrown.into());
        }

        self.hosted_records.insert(
            scope.to_string(),
            HostedRecord {
                component,
                manifest,
            },
        );
        Ok(self.describe_one(scope))
    }

    /// Swap the instance behind a hosted scope for a fresh one of its
    /// component, **keeping the scope's state** (hot reload): `register` →
    /// `instantiate` → `actions` in the host, re-wire, destroy the old
    /// instance. `init` does not run. The old instance's subscriptions are
    /// dropped; call `activateHostedModule` so the new one can re-subscribe.
    ///
    /// `component`, `manifest` and `actions` default to what the scope was
    /// registered with (the action list is re-queried from the module).
    /// Returns the same descriptor as `registerHostedModule`. On failure the
    /// old instance stays in charge.
    #[wasm_bindgen(js_name = reloadHostedModule)]
    pub fn reload_hosted_module(
        &mut self,
        scope: &str,
        component: Option<String>,
        manifest: JsValue,
        actions: JsValue,
    ) -> Result<JsValue, JsValue> {
        let scope = scope.to_lowercase();
        let scope = scope.as_str();
        let (Some(old_id), Some(record)) = (
            self.hosted.instance_id(scope),
            self.hosted_records.get(scope),
        ) else {
            return Err(Thrown::new(
                "unknownModule",
                format!("no hosted module under scope '{scope}'"),
            )
            .scope(scope)
            .into());
        };
        let component = component
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| record.component.clone());
        let mut manifest = manifest_arg(manifest)?.unwrap_or_else(|| record.manifest.clone());
        if manifest.name.is_empty() {
            manifest.name.clone_from(&component);
        }
        let forced_actions = actions_arg(actions)?;
        let grants = ModuleGrants::from(&manifest);

        let host = self
            .hosted
            .host_mut()
            .ok_or_else(|| Thrown::new("noModuleHost", "no module host installed"))?;
        host.register(&component, &[], manifest.clone())
            .map_err(|error| Thrown::host(scope, "register", &error))?;
        let new_id = host
            .instantiate(&component)
            .map_err(|error| Thrown::host(scope, "instantiate", &error))?;

        let wired = (|| {
            let actions = self.hosted_actions(scope, new_id, forced_actions)?;
            self.with_hosted(|hosted, ctx| hosted.rewire(ctx, scope, new_id, actions, grants))
                .map_err(|error| Self::wiring_error(scope, error))
        })();
        if let Err(thrown) = wired {
            if let Some(host) = self.hosted.host_mut() {
                let _ = host.destroy(new_id);
            }
            return Err(thrown.into());
        }
        if old_id != new_id {
            if let Some(host) = self.hosted.host_mut() {
                let _ = host.destroy(old_id);
            }
        }
        self.hosted_records.insert(
            scope.to_string(),
            HostedRecord {
                component,
                manifest,
            },
        );
        Ok(self.describe_one(scope))
    }

    /// Run the hosted module's `on_activated` and fold its output like a
    /// dispatch (this is where a module subscribes to other scopes). Returns
    /// `false`, doing nothing, when `scope` hosts no module.
    #[wasm_bindgen(js_name = activateHostedModule)]
    pub fn activate_hosted_module(&mut self, scope: &str) -> Result<bool, JsValue> {
        self.run_hosted_lifecycle(scope, LifecycleHook::Activated)
    }

    /// Run the hosted module's `on_deactivated` and fold its output. Returns
    /// `false`, doing nothing, when `scope` hosts no module.
    #[wasm_bindgen(js_name = deactivateHostedModule)]
    pub fn deactivate_hosted_module(&mut self, scope: &str) -> Result<bool, JsValue> {
        self.run_hosted_lifecycle(scope, LifecycleHook::Deactivated)
    }

    /// Tear a hosted module down: run `on_destroyed`, remove everything the
    /// engine holds for the scope (instance, routing, grants, subscriptions
    /// in both directions, the state slot), destroy the host-side instance.
    /// Returns `false` when `scope` hosts no module.
    ///
    /// The teardown always completes; when the hook or the host's `destroy`
    /// failed, that is thrown afterwards (`hostError`, `stage`
    /// `"onDestroyed"` / `"destroy"`).
    #[wasm_bindgen(js_name = destroyHostedModule)]
    pub fn destroy_hosted_module(&mut self, scope: &str) -> Result<bool, JsValue> {
        self.destroy_hosted(scope)
    }

    /// Dispatch `name` straight to the hosted module under `scope`.
    ///
    /// **Host-trusted**: it skips the renderer's ownership checks, so never
    /// feed it a scope or name taken from client input (that is
    /// `dispatchAction`). `payload` is any JSON value.
    ///
    /// Throws `unknownModule` / `actionNotAccepted` before anything runs;
    /// `moduleCallFailed` when the module's own call failed (nothing
    /// applied); `cascadeIncomplete` when it ran and some follow-ups failed
    /// (applied state stands). The last two carry `report`.
    #[wasm_bindgen(js_name = dispatchModuleAction)]
    pub fn dispatch_module_action(
        &mut self,
        scope: &str,
        name: &str,
        payload: JsValue,
    ) -> Result<(), JsValue> {
        let payload = json_arg("payload", payload)?;
        let scope = scope.to_lowercase();
        if self.hosted.instance_id(&scope).is_none() {
            return Err(Thrown::new(
                "unknownModule",
                format!("no hosted module under scope '{scope}'"),
            )
            .scope(&scope)
            .into());
        }
        self.cascade_call(
            Some(&scope),
            |hosted, ctx| hosted.dispatch_trusted(ctx, &scope, name, payload),
            |error| {
                let code = match error {
                    EngineError::ActionNotFound(_) => "actionNotAccepted",
                    _ => "moduleError",
                };
                Thrown::new(code, error.to_string()).scope(&scope).into()
            },
        )
    }

    /// Every hosted module, in registration order:
    /// `[{ scope, component, instanceId, actions, wildcard }]`. `actions`
    /// are the names the module lists; `wildcard` says it also accepts any
    /// other application action.
    #[wasm_bindgen(js_name = hostedModules)]
    pub fn hosted_modules(&self) -> JsValue {
        plain(&self.describe_hosted())
    }

    /// The whole current state of the module registered under `scope` (any
    /// letter case) — hosted or in-process — or `null` when there is none.
    ///
    /// **Host-trusted**: unlike `getStateAt`, which serves an external caller
    /// only what the rendered templates declare, this returns everything the
    /// module holds. A hosted module's state lives only in the engine, so
    /// this is how server code reads it.
    #[wasm_bindgen(js_name = getModuleState)]
    pub fn get_module_state(&self, scope: &str) -> JsValue {
        let scope = scope.to_lowercase();
        if self.core.placeholder_scopes.contains(&scope) {
            return JsValue::NULL;
        }
        self.core
            .get_module_state(&scope)
            .map_or(JsValue::NULL, plain)
    }

    /// Whether `scope` (any letter case) hosts a module.
    #[wasm_bindgen(js_name = isHostedModule)]
    pub fn is_hosted_module(&self, scope: &str) -> bool {
        self.hosted.instance_id(scope).is_some()
    }

    /// The structured failures of the most recent module cascade — a
    /// dispatch (`dispatchAction` reaching a hosted module, or
    /// `dispatchModuleAction`), a lifecycle call, or the subscriber
    /// notifications of an `updateState*` — or `null` when it had none.
    ///
    /// `{ root: { kind, scope, action, hook? }, rootFailed, failureCount,
    /// failures: [{ scope, action, outcome, isRoot, origin: { kind, … },
    /// cause: { code, … }, message }], message }`. It is the only place the
    /// failures of a state write's notifications surface, since
    /// `updateState*` do not throw for them.
    #[wasm_bindgen(js_name = lastModuleCascadeReport)]
    pub fn last_module_cascade_report(&self) -> JsValue {
        self.hosted
            .last_report()
            .map_or(JsValue::NULL, |report| plain(&report.to_json()))
    }
    /// Complete a deferred HTTP request (`hypen:http/deferred`): report how
    /// the request an `{ type: "http", id, … }` effect asked for ended, and
    /// run the module's completion action with it.
    ///
    /// `result` is `{ ok: true, status, headers?, body? }` (any status — a
    /// 404 is a completed exchange) or `{ ok: false, error: { kind, message? } }`
    /// with `kind` one of `"network"`, `"timeout"`, `"denied"`,
    /// `"too-large"`, `"invalid-response"`. `headers` is an object or an
    /// array of `[name, value]` pairs; `body` a `Uint8Array`, `ArrayBuffer`
    /// or string.
    ///
    /// Returns `true` when the completion action ran, `false` when the
    /// module was destroyed or reloaded while the request was in flight (the
    /// result is dropped). Call it exactly once per effect, and not from
    /// inside the effect handler (the engine is busy there): perform the
    /// request asynchronously and complete it when it settles.
    ///
    /// Throws `invalidArgument` (nothing consumed: the request stays in
    /// flight), `unknownHttpRequest`, and — when the completion action ran
    /// and failed — `moduleCallFailed` / `cascadeIncomplete` with `report`.
    #[wasm_bindgen(js_name = completeHttpRequest)]
    pub fn complete_http_request(&mut self, id: f64, result: JsValue) -> Result<bool, JsValue> {
        let id = http_request_id(id)?;
        let outcome = http_outcome_arg(&result)?;
        let mut delivery = None;
        let mut unknown = false;
        self.cascade_call(
            None,
            |hosted, ctx| match hosted.complete_http(ctx, id, outcome) {
                Ok(delivered) => {
                    delivery = Some(delivered);
                    Ok(())
                }
                Err(HttpCompletionError::UnknownRequest(_)) => {
                    unknown = true;
                    Ok(())
                }
                Err(HttpCompletionError::Cascade(error)) => Err(error),
            },
            |error| Thrown::new("moduleError", error.to_string()).into(),
        )?;
        if unknown {
            return Err(Thrown::new(
                "unknownHttpRequest",
                HttpCompletionError::UnknownRequest(id).to_string(),
            )
            .into());
        }
        Ok(delivery == Some(HttpDelivery::Delivered))
    }

    /// Whether the deferred HTTP request in flight under `id` may be sent on
    /// to `url` — the allowlist check an effect handler makes before it
    /// follows a redirect (use `redirect: "manual"` and ask per hop). `false`
    /// for a URL the module may not request, one that is not a valid
    /// `http(s)` URL, or an id that is not in flight.
    #[wasm_bindgen(js_name = httpRedirectAllowed)]
    pub fn http_redirect_allowed(&self, id: f64, url: &str) -> bool {
        let (Ok(id), Ok(url)) = (http_request_id(id), HttpUrl::parse(url)) else {
            return false;
        };
        matches!(self.hosted.http_redirect_check(id, &url), Some(Ok(())))
    }

    /// How many deferred HTTP requests one hosted module may have in flight.
    #[wasm_bindgen(js_name = moduleHttpInFlightLimit)]
    pub fn module_http_in_flight_limit(&self) -> u32 {
        u32::try_from(self.hosted.http_in_flight_limit()).unwrap_or(u32::MAX)
    }

    /// Set the per-module in-flight cap for deferred HTTP (at least 1).
    #[wasm_bindgen(js_name = setModuleHttpInFlightLimit)]
    pub fn set_module_http_in_flight_limit(&mut self, limit: u32) {
        self.hosted.set_http_in_flight_limit(limit as usize);
    }


    /// Install (or, with `null` / `undefined`, remove) the handler for the
    /// effects a hosted reducer returns that only the embedder can perform.
    /// Called as `handler(scope, effect)` with
    /// `{ type: "navigate", path }`, `{ type: "delay", ms, then }` (after
    /// `ms`, dispatch `then` to `scope` with `dispatchModuleAction`) or
    /// `{ type: "http", id, request, then, tag, allowedHosts }` (perform the
    /// request, then report it with `completeHttpRequest(id, result)`; the
    /// shape is documented on `http_effect_js`). `log` effects go to the
    /// engine's logger and never reach it. Without a handler, deferred HTTP
    /// requests are refused and completed to the module as `denied`.
    ///
    /// The handler runs while the engine call that produced the effect is
    /// still in progress: it must not call the engine synchronously.
    #[wasm_bindgen(js_name = setModuleEffectHandler)]
    pub fn set_module_effect_handler(&mut self, handler: JsValue) -> Result<(), JsValue> {
        if handler.is_undefined() || handler.is_null() {
            self.hosted.clear_effect_handler();
            return Ok(());
        }
        let handler: js_sys::Function = handler
            .dyn_into()
            .map_err(|_| invalid("handler", "expected a function or null"))?;
        let handler = JsEffectHandler(handler);
        self.hosted
            .set_effect_handler(Box::new(move |scope, effect| handler.call(scope, effect)));
        Ok(())
    }

    /// The most reducer invocations (the root included) one dispatch,
    /// lifecycle call or state write may cause in hosted modules and
    /// in-process handlers reached by cross-dispatch.
    #[wasm_bindgen(js_name = moduleDispatchBudget)]
    pub fn module_dispatch_budget(&self) -> u32 {
        u32::try_from(self.hosted.dispatch_budget()).unwrap_or(u32::MAX)
    }

    /// Set the dispatch budget (at least 1).
    #[wasm_bindgen(js_name = setModuleDispatchBudget)]
    pub fn set_module_dispatch_budget(&mut self, budget: u32) {
        self.hosted.set_dispatch_budget(budget as usize);
    }
}

impl WasmEngine {
    fn run_hosted_lifecycle(&mut self, scope: &str, hook: LifecycleHook) -> Result<bool, JsValue> {
        let scope = scope.to_lowercase();
        if self.hosted.instance_id(&scope).is_none() {
            return Ok(false);
        }
        self.cascade_call(
            Some(&scope),
            |hosted, ctx| hosted.run_lifecycle(ctx, &scope, hook),
            |error| {
                Thrown::new("moduleError", error.to_string())
                    .scope(&scope)
                    .into()
            },
        )?;
        Ok(true)
    }
}
