//! UniFFI bindings for Hypen Engine
//!
//! This module provides native bindings for Kotlin, Swift, Python, and Ruby
//! via Mozilla's UniFFI framework.
//!
//! ## Building for Kotlin
//!
//! ```bash
//! # Build the native library
//! cargo build --release --features uniffi
//!
//! # Generate Kotlin bindings (the workspace target dir is one level up)
//! cargo run --features uniffi-cli --bin uniffi-bindgen -- generate \
//!     --library ../target/release/libhypen_engine.so \
//!     --language kotlin \
//!     --out-dir ../hypen-kotlin/src/main/kotlin
//! ```

use std::sync::{Arc, Mutex};

/// Device broker (RFC 001) bindings: `DeviceBroker`, `DeviceRetainedBytesPool`
/// and the `device*` handshake helpers.
pub mod device;

use crate::{
    engine_core::EngineCore,
    ir::{ast_to_ir_node, IRNode},
    lifecycle::ModuleInstance,
    reconcile::Patch as InternalPatch,
};

// UniFFI scaffolding is set up in lib.rs

/// Version information
#[uniffi::export]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── Portable helpers (see engine::portable) ──────────────────────────────
//
// UniFFI-visible surface for the engine's portable helpers. All three
// take JSON strings in and return JSON strings out so the UDL stays
// stable as the underlying Rust types evolve. Kotlin and Swift call
// these via the generated bindings and deserialise into whatever
// native shape suits the host.

/// Compute the dotted-path diff between two JSON blobs.
///
/// Accepts `old_json` and `new_json` as JSON strings; returns a JSON
/// array of `{"path": "...", "value": <json>}` objects describing every
/// leaf that changed. Replaces per-host `diffState` ports.
#[uniffi::export]
pub fn portable_diff_paths(old_json: String, new_json: String) -> Result<String, HypenError> {
    let old: serde_json::Value = serde_json::from_str(&old_json)
        .map_err(|e| HypenError::StateError(format!("diff_paths: bad old JSON: {e}")))?;
    let new: serde_json::Value = serde_json::from_str(&new_json)
        .map_err(|e| HypenError::StateError(format!("diff_paths: bad new JSON: {e}")))?;

    let entries: Vec<serde_json::Value> = crate::portable::diff_paths(&old, &new)
        .into_iter()
        .map(|e| serde_json::json!({ "path": e.path, "value": e.new_value }))
        .collect();

    serde_json::to_string(&entries)
        .map_err(|e| HypenError::StateError(format!("diff_paths: serialise: {e}")))
}

/// Match a URL pattern against a path.
///
/// Returns a JSON string `{"matched": bool, "params": {"id": "42"}}`
/// on success. Unmatched patterns return `{"matched": false, "params": {}}`.
/// Replaces per-host `matchPath` ports.
/// Parse a Hypen DSL source and return every `Router { Route ... }` block
/// it contains. Returns JSON matching the TS / Go `discoverRouters`
/// shape — `[{ "module_scope": null|"name", "routes": [{ "path": "...",
/// "element_names": ["..."] }] }]`. The Swift/Kotlin SDKs use this to
/// auto-wire a per-session ManagedRouter so examples don't have to
/// repeat the route table in host code.
#[uniffi::export]
pub fn discover_routers(source: String) -> Result<String, HypenError> {
    let doc = hypen_parser::parse_document(&source).map_err(|e| {
        HypenError::StateError(format!("discover_routers: parse error: {}", e.len()))
    })?;
    let mut routers = Vec::new();
    for component in &doc.components {
        let ir = crate::ir::ast_to_ir_node(component);
        routers.extend(crate::ir::discover_routers(&ir));
    }
    serde_json::to_string(&routers)
        .map_err(|e| HypenError::StateError(format!("discover_routers: serialise: {e}")))
}

#[uniffi::export]
pub fn portable_match_path(pattern: String, path: String) -> String {
    match crate::portable::match_path(&pattern, &path) {
        Some(m) => {
            let params: serde_json::Map<String, serde_json::Value> = m
                .params
                .into_iter()
                .map(|(k, v)| (k, serde_json::Value::String(v)))
                .collect();
            serde_json::json!({ "matched": true, "params": params }).to_string()
        }
        None => serde_json::json!({ "matched": false, "params": {} }).to_string(),
    }
}

/// Read the value at a dotted path; returns JSON (or `"null"` if the
/// path doesn't resolve).
#[uniffi::export]
pub fn portable_path_get(value_json: String, path: String) -> Result<String, HypenError> {
    let v: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|e| HypenError::StateError(format!("path_get: bad JSON: {e}")))?;
    let out = crate::portable::path_get(&v, &path).unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&out)
        .map_err(|e| HypenError::StateError(format!("path_get: serialise: {e}")))
}

/// Returns `"true"` or `"false"` (JSON booleans) for whether `path`
/// resolves inside `value_json`.
#[uniffi::export]
pub fn portable_path_has(value_json: String, path: String) -> Result<String, HypenError> {
    let v: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|e| HypenError::StateError(format!("path_has: bad JSON: {e}")))?;
    Ok(if crate::portable::path_has(&v, &path) {
        "true"
    } else {
        "false"
    }
    .to_string())
}

/// Set `new_value_json` at `path` inside `value_json`; returns the
/// updated JSON. Intermediate objects are created; arrays are extended
/// with `null` padding.
#[uniffi::export]
pub fn portable_path_set(
    value_json: String,
    path: String,
    new_value_json: String,
) -> Result<String, HypenError> {
    let mut v: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|e| HypenError::StateError(format!("path_set: bad value JSON: {e}")))?;
    let nv: serde_json::Value = serde_json::from_str(&new_value_json)
        .map_err(|e| HypenError::StateError(format!("path_set: bad new-value JSON: {e}")))?;
    crate::portable::path_set(&mut v, &path, nv);
    serde_json::to_string(&v)
        .map_err(|e| HypenError::StateError(format!("path_set: serialise: {e}")))
}

/// Move element `from` of the array at `from_path` to index `to` of the
/// array at `to_path` (the `__hypen_reorder` primitive; see
/// [`crate::portable::path_move`] for the exact semantics — `to` is the
/// final index, clamped after removal). Returns
/// `{"json": <updated>, "moved": bool}`; on `moved: false` the JSON is the
/// input unchanged.
#[uniffi::export]
pub fn portable_path_move(
    value_json: String,
    from_path: String,
    from: u32,
    to_path: String,
    to: u32,
) -> Result<String, HypenError> {
    let mut v: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|e| HypenError::StateError(format!("path_move: bad JSON: {e}")))?;
    let moved =
        crate::portable::path_move(&mut v, &from_path, from as usize, &to_path, to as usize);
    serde_json::to_string(&serde_json::json!({ "json": v, "moved": moved }))
        .map_err(|e| HypenError::StateError(format!("path_move: serialise: {e}")))
}

/// Delete the value at `path`. Returns `{"json": <updated>, "removed": bool}`.
#[uniffi::export]
pub fn portable_path_delete(value_json: String, path: String) -> Result<String, HypenError> {
    let mut v: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|e| HypenError::StateError(format!("path_delete: bad JSON: {e}")))?;
    let removed = crate::portable::path_delete(&mut v, &path);
    serde_json::to_string(&serde_json::json!({ "json": v, "removed": removed }))
        .map_err(|e| HypenError::StateError(format!("path_delete: serialise: {e}")))
}

/// Percent-encode a string for use in URL query components.
#[uniffi::export]
pub fn portable_encode_uri_component(input: String) -> String {
    crate::portable::encode_uri_component(&input)
}

/// Decode a percent-encoded string; `+` decodes to space.
#[uniffi::export]
pub fn portable_decode_uri_component(input: String) -> String {
    crate::portable::decode_uri_component(&input)
}

/// Split `"/path?k=v"` into JSON `{"path": "...", "query": {"k": "v"}}`.
#[uniffi::export]
pub fn portable_parse_query(full_path: String) -> String {
    let (path, query) = crate::portable::parse_query(&full_path);
    serde_json::json!({ "path": path, "query": query }).to_string()
}

/// Build a URL from `path` and a JSON object of query params.
#[uniffi::export]
pub fn portable_build_url(path: String, query_json: String) -> Result<String, HypenError> {
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&query_json)
        .map_err(|e| HypenError::StateError(format!("build_url: bad query JSON: {e}")))?;
    Ok(crate::portable::build_url(&path, &map))
}

/// Advance the session state machine by one event.
///
/// `state_json` and `event_json` are the serialised `SessionState` /
/// `SessionEvent` from the portable module. Returns the serialised
/// `SessionEffect`.
#[uniffi::export]
pub fn portable_session_step(state_json: String, event_json: String) -> Result<String, HypenError> {
    let state: crate::portable::SessionState = serde_json::from_str(&state_json)
        .map_err(|e| HypenError::StateError(format!("session_step: bad state JSON: {e}")))?;
    let event: crate::portable::SessionEvent = serde_json::from_str(&event_json)
        .map_err(|e| HypenError::StateError(format!("session_step: bad event JSON: {e}")))?;

    let effect = crate::portable::session_step(&state, &event);
    serde_json::to_string(&effect)
        .map_err(|e| HypenError::StateError(format!("session_step: serialise: {e}")))
}

/// Patch types for DOM operations
#[derive(Debug, Clone, uniffi::Enum)]
pub enum PatchType {
    Create,
    SetProp,
    RemoveProp,
    SetText,
    Insert,
    Move,
    Remove,
    /// Unlink a subtree from its parent without destroying it. Renderer
    /// keeps the native element alive for a later `Attach`. Emitted by
    /// the engine's Router subtree cache on navigation-away.
    Detach,
    /// Reattach a previously-detached subtree under the same NodeId.
    /// Emitted by the engine's Router subtree cache on navigation-back.
    Attach,
    /// Replace a node's accessibility semantics after a reactive change
    /// (templated accessible name, bound self-state, bound checked). The
    /// updated block rides `semantics_json`; renderers re-apply it with the
    /// same translation they run at create, clearing attributes the new
    /// block no longer sets. `semantics_json == None` clears everything.
    SetSemantics,
    /// Batch-scoped animation prelude (transaction-scoped animation).
    /// Addresses no node — it scopes the *batch*: renderers that
    /// understand it animate every prop change in the patches that
    /// follow using the spec carried on `spec_json`. Only ever valid at
    /// batch index 0; a prelude anywhere else is not a stamp.
    ///
    /// **Appended last on purpose.** UniFFI enum discriminants are
    /// positional (the generated Kotlin does `PatchType.values()[i - 1]`
    /// and Swift switches on the same ordinal), so new variants must go
    /// at the end or every existing case shifts.
    BatchAnimation,
}

/// A patch represents a single DOM operation
#[derive(Debug, Clone, uniffi::Record)]
pub struct Patch {
    pub patch_type: PatchType,
    pub id: String,
    pub element_type: Option<String>,
    pub props_json: Option<String>,
    pub name: Option<String>,
    pub value_json: Option<String>,
    pub text: Option<String>,
    pub parent_id: Option<String>,
    pub before_id: Option<String>,
    /// Serialized `Semantics` block (camelCase JSON, same shape as the web
    /// wire format). Present on `Create` for nodes with derivable a11y and
    /// on every `SetSemantics`. Defaults to `None` so existing Kotlin/Swift
    /// constructors keep compiling.
    #[uniffi(default = None)]
    pub semantics_json: Option<String>,
    /// Roots an animated exit: set on the **root** `Remove` of a subtree
    /// whose node carried an `"__anim.exit"` spec. The renderer may play
    /// the exit and finalize teardown itself; the engine-side node is
    /// dead the moment the patch is emitted (no ack round-trip). `false`
    /// on every other patch type — which matches the wire default, where
    /// the field is skip-if-false, so relays that re-serialize this
    /// record stay byte-identical for unflagged removes.
    #[uniffi(default = false)]
    pub transition: bool,
    /// Animation spec for `PatchType::BatchAnimation`, as a JSON *string*
    /// (UniFFI has no arbitrary-JSON type, so the engine's `serde_json`
    /// object is stringified at this boundary and consumers parse it).
    /// Always a JSON object, e.g. `{"curve":"spring","duration":250}`.
    /// `None` on every other patch type.
    ///
    /// **Both fields are appended last on purpose.** The generated
    /// Kotlin/Swift record readers are positional, so inserting a field
    /// anywhere but the tail silently mis-reads every field after it.
    #[uniffi(default = None)]
    pub spec_json: Option<String>,
}

impl Patch {
    /// Convert an engine patch into the flat FFI record.
    ///
    /// **Every** engine patch variant now crosses the uniffi boundary —
    /// this is total, and deliberately so. It used to return `Option` and
    /// drop `BatchAnimation`; nothing is dropped any more, so the
    /// conversion is infallible and call sites use a plain `map`. Keep it
    /// that way: a silent drop here is invisible to Kotlin/Swift hosts and
    /// to any browser client they relay to.
    ///
    /// The engine's `Arc<str>` ids are copied into owned `String`s here —
    /// UniFFI records can't carry refcounted strings, so this boundary is
    /// the one place the memoized ids are re-allocated.
    fn from_internal(p: InternalPatch) -> Self {
        match p {
            // The batch-animation prelude. UniFFI has no arbitrary-JSON
            // type, so the spec object is stringified into `spec_json` and
            // the consumer parses it. It addresses no node, so `id` is
            // empty — hosts must route on `patch_type`, never on `id`.
            //
            // Contract: honored ONLY at batch index 0. Renderers that don't
            // understand it ignore it and snap; the rest of the batch is
            // wire-identical to an unstamped one.
            // Template-instantiation patches never reach this conversion:
            // every batch is lowered through `EngineState`'s
            // `TemplateExpander` (see `lower_patches`) BEFORE flattening to
            // the FFI record — and `lower_patches` drops (with a warning)
            // any template patch the expander passed through on its
            // degraded paths — so mobile hosts always see the plain
            // `Create`+`Insert` wire. If this ever fires, a new
            // patch-producing entry point bypassed `lower_patches`; route
            // it through there rather than extending `PatchType`.
            InternalPatch::RegisterTemplate { .. } | InternalPatch::Instantiate { .. } => {
                unreachable!("template patches are expanded by lower_patches before FFI conversion")
            }
            InternalPatch::BatchAnimation { spec } => Patch {
                patch_type: PatchType::BatchAnimation,
                id: String::new(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition: false,
                spec_json: Some(serde_json::to_string(&spec).unwrap_or_else(|_| "{}".to_string())),
            },
            InternalPatch::Create {
                id,
                element_type,
                props,
                semantics,
            } => Patch {
                patch_type: PatchType::Create,
                id: id.to_string(),
                element_type: Some(element_type),
                props_json: Some(serde_json::to_string(&*props).unwrap_or_default()),
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: semantics
                    .as_ref()
                    .and_then(|s| serde_json::to_string(s).ok()),
                transition: false,
                spec_json: None,
            },
            InternalPatch::SetSemantics { id, semantics } => Patch {
                patch_type: PatchType::SetSemantics,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: semantics
                    .as_ref()
                    .and_then(|s| serde_json::to_string(s).ok()),
                transition: false,
                spec_json: None,
            },
            InternalPatch::SetProp { id, name, value } => Patch {
                patch_type: PatchType::SetProp,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: Some(name),
                value_json: Some(serde_json::to_string(&value).unwrap_or_default()),
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            InternalPatch::RemoveProp { id, name } => Patch {
                patch_type: PatchType::RemoveProp,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: Some(name),
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            InternalPatch::SetText { id, text } => Patch {
                patch_type: PatchType::SetText,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: Some(text),
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            InternalPatch::Insert {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Insert,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id.to_string()),
                before_id: before_id.map(|b| b.to_string()),
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            InternalPatch::Move {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Move,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id.to_string()),
                before_id: before_id.map(|b| b.to_string()),
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            // The deferred-remove flag now crosses this boundary. A
            // `transition: true` Remove roots an exiting subtree: it is
            // emitted FIRST, before its descendants' plain Removes, so a
            // Kotlin/Swift renderer learns the subtree is exiting before
            // teardown arrives and can defer the native removal to play the
            // exit. Hosts relaying to a browser client must re-emit it (as
            // skip-if-false JSON) or that client snaps.
            InternalPatch::Remove { id, transition } => Patch {
                patch_type: PatchType::Remove,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition,
                spec_json: None,
            },
            // Detach/Attach are emitted by the engine's Router
            // subtree cache: Detach unlinks a subtree from its parent
            // without freeing the native element; Attach reinserts it
            // under the same id. Kotlin/Swift renderers must keep the
            // native element alive between a Detach and the following
            // Attach. See `hypen-engine-rs/src/reconcile/diff.rs` for
            // the Router reconciliation that emits these.
            InternalPatch::Detach { id } => Patch {
                patch_type: PatchType::Detach,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
            InternalPatch::Attach {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Attach,
                id: id.to_string(),
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id.to_string()),
                before_id: before_id.map(|b| b.to_string()),
                semantics_json: None,
                transition: false,
                spec_json: None,
            },
        }
    }
}

/// Action dispatched from UI
#[derive(Debug, Clone, uniffi::Record)]
pub struct Action {
    pub name: String,
    pub payload_json: Option<String>,
}

/// Module configuration
#[derive(Debug, Clone, uniffi::Record)]
pub struct ModuleConfig {
    pub name: String,
    pub actions: Vec<String>,
    pub state_keys: Vec<String>,
    pub initial_state_json: String,
}

/// Component definition for registration
#[derive(Debug, Clone, uniffi::Record)]
pub struct ComponentDef {
    pub name: String,
    pub source: String,
    pub path: String,
}

/// Error type for engine operations
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum HypenError {
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("Render error: {0}")]
    RenderError(String),
    #[error("State error: {0}")]
    StateError(String),
    #[error("Action error: {0}")]
    ActionError(String),
    #[error("Component error: {0}")]
    ComponentError(String),
    #[error("Initialization error: {0}")]
    InitializationError(String),
}

impl From<crate::error::EngineError> for HypenError {
    fn from(err: crate::error::EngineError) -> Self {
        match err {
            crate::error::EngineError::ParseError { message, .. } => {
                HypenError::ParseError(message)
            }
            crate::error::EngineError::ComponentNotFound(name) => HypenError::ComponentError(name),
            crate::error::EngineError::RenderError(msg) => HypenError::RenderError(msg),
            crate::error::EngineError::ActionNotFound(name) => {
                HypenError::ActionError(format!("No handler registered for action: {}", name))
            }
            // A refusal, not a missing handler. Kept distinct in the message so
            // a host can tell "not allowed" from "no such thing" — the two map
            // to different HTTP statuses and different agent behaviour.
            crate::error::EngineError::NotDeclared(detail) => {
                HypenError::ActionError(format!("Not declared by this app: {}", detail))
            }
            crate::error::EngineError::StateError(msg) => HypenError::StateError(msg),
            crate::error::EngineError::ExpressionError(msg) => {
                HypenError::RenderError(format!("Expression error: {}", msg))
            }
        }
    }
}

/// Import information returned to SDK hosts (Kotlin, Swift, etc.)
#[derive(Debug, Clone, uniffi::Record)]
pub struct ImportInfo {
    /// Component names being imported (e.g., ["Button", "Card"])
    pub names: Vec<String>,
    /// Source path (e.g., "./components/ui" or "https://cdn.example.com/ui")
    pub source_path: String,
    /// Source type: "local" or "url"
    pub source_type: String,
}

/// Internal engine state.
///
/// Wraps the shared `EngineCore` (component/resource registries, module
/// state, tree, dependency graph, scheduler, revision) with the UniFFI-only
/// bookkeeping needed for polling-based action and import dispatch.
struct EngineState {
    core: EngineCore,
    /// Actions queued by `dispatch_action`, drained by `get_pending_actions`.
    pending_actions: Vec<Action>,
    /// Imports from the last rendered document, drained by `get_pending_imports`.
    pending_imports: Vec<ImportInfo>,
    /// Mobile hosts can't exploit template cloning, so template patches are
    /// lowered back to plain `Create`+`Insert` runs before flattening to
    /// the FFI record. Session-lifetime state: skeletons registered by
    /// earlier batches expand later `Instantiate`s.
    template_expander: crate::portable::TemplateExpander,
}

impl EngineState {
    /// Lower template patches and flatten the batch to the FFI record.
    /// Every patch-returning entry point funnels through here so no path
    /// can leak `RegisterTemplate`/`Instantiate` across the FFI.
    fn lower_patches(&mut self, patches: Vec<InternalPatch>) -> Vec<Patch> {
        self.template_expander
            .expand(patches)
            .into_iter()
            .filter(|p| {
                // The expander passes template patches through on its
                // degraded paths (unknown template id, malformed skeleton)
                // instead of panicking. Mobile hosts have no PatchType for
                // them, so drop the stragglers here — with a warning —
                // rather than letting `from_internal`'s unreachable! turn
                // graceful degradation into a cross-FFI panic.
                let is_template = matches!(
                    p,
                    InternalPatch::RegisterTemplate { .. } | InternalPatch::Instantiate { .. }
                );
                if is_template {
                    crate::log_warn!(
                        crate::logger::LogScope::Engine,
                        "dropping unexpanded template patch at the uniffi boundary"
                    );
                }
                !is_template
            })
            .map(Patch::from_internal)
            .collect()
    }
}

/// The main Hypen engine interface
#[derive(uniffi::Object)]
pub struct HypenEngine {
    state: Mutex<EngineState>,
}

#[uniffi::export]
impl HypenEngine {
    /// Create a new engine instance
    #[uniffi::constructor]
    pub fn new() -> Result<Arc<Self>, HypenError> {
        Ok(Arc::new(Self {
            state: Mutex::new(EngineState {
                core: EngineCore::new(),
                pending_actions: Vec::new(),
                pending_imports: Vec::new(),
                template_expander: crate::portable::TemplateExpander::new(),
            }),
        }))
    }

    /// Parse Hypen DSL and return AST as JSON
    pub fn parse_to_json(&self, source: String) -> Result<String, HypenError> {
        match hypen_parser::parse_component(&source) {
            Ok(component) => serde_json::to_string_pretty(&component)
                .map_err(|e| HypenError::ParseError(e.to_string())),
            Err(errors) => {
                let msg = errors
                    .iter()
                    .map(|e| hypen_parser::error::format_error_simple(e))
                    .collect::<Vec<_>>()
                    .join("; ");
                Err(HypenError::ParseError(msg))
            }
        }
    }

    /// Render Hypen DSL source and return patches.
    ///
    /// Supports documents with `import` statements — call
    /// [`get_pending_imports`](Self::get_pending_imports) afterwards to
    /// retrieve imports the host SDK should resolve and re-feed via
    /// [`register_component`](Self::register_component).
    pub fn render_source(&self, source: String) -> Result<Vec<Patch>, HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::RenderError(e.to_string()))?;

        let doc = hypen_parser::parse_document(&source).map_err(|e| {
            let msg = e
                .iter()
                .map(|err| hypen_parser::error::format_error_simple(err))
                .collect::<Vec<_>>()
                .join("; ");
            HypenError::ParseError(msg)
        })?;

        state.pending_imports = doc
            .imports
            .iter()
            .map(|imp| {
                let (source_path, source_type) = match &imp.source {
                    hypen_parser::ImportSource::Local(p) => (p.clone(), "local".to_string()),
                    hypen_parser::ImportSource::Url(u) => (u.clone(), "url".to_string()),
                };
                ImportInfo {
                    names: imp
                        .imported_names()
                        .into_iter()
                        .map(|s| s.to_string())
                        .collect(),
                    source_path,
                    source_type,
                }
            })
            .collect();

        let component = doc
            .components
            .first()
            .ok_or_else(|| HypenError::ParseError("No component found in source".to_string()))?;

        let ir_node = ast_to_ir_node(component);
        let patches = state.core.render_ir_node(&ir_node);

        Ok(state.lower_patches(patches))
    }

    /// Update engine state with a JSON patch and re-render affected nodes.
    ///
    /// # Arguments
    /// * `scope` — Empty string targets the primary module set via [`set_module`].
    ///             A non-empty value (e.g. `"search"`) targets a named module
    ///             registered via [`register_module`]; invalidation is scoped
    ///             to `mod:<scope>:<path>` so sibling modules are not re-rendered.
    /// * `state_json` — JSON object with state changes (deep-merged into the
    ///                  target module's state).
    pub fn update_state(
        &self,
        scope: String,
        state_json: String,
    ) -> Result<Vec<Patch>, HypenError> {
        let patch: serde_json::Value =
            serde_json::from_str(&state_json).map_err(|e| HypenError::StateError(e.to_string()))?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::StateError(e.to_string()))?;

        let scope = if scope.is_empty() { None } else { Some(scope) };
        // Host-side batch stamping is not exposed over uniffi yet: this
        // method has no animation argument, so it passes `None`. Preludes
        // the engine raises on its own DO now relay (`from_internal` maps
        // `BatchAnimation`); adding an optional animation parameter here is
        // the remaining piece for Kotlin/Swift-initiated stamps.
        if !state.core.update_state(scope.as_deref(), patch, None) {
            return Ok(Vec::new());
        }

        let patches = state.core.render_dirty();
        Ok(state.lower_patches(patches))
    }

    /// Apply a sparse state update with explicit dotted path → value pairs.
    ///
    /// Use this when you already know which paths changed (typical for the
    /// `ObservableState`-driven mobile SDKs) so the engine doesn't need to
    /// walk a nested patch to find them. Each path is applied directly to
    /// the target module's state and used to invalidate dependencies.
    ///
    /// # Arguments
    /// * `scope` — Empty string targets the primary module, otherwise the
    ///             named module registered via [`register_module`]. Case is
    ///             normalized internally.
    /// * `paths_json` — JSON array of dotted path strings (`["count"]`,
    ///                  `["user.name", "user.email"]`).
    /// * `values_json` — JSON object keyed by the same paths.
    pub fn update_state_sparse(
        &self,
        scope: String,
        paths_json: String,
        values_json: String,
    ) -> Result<Vec<Patch>, HypenError> {
        let paths: Vec<String> = serde_json::from_str(&paths_json)
            .map_err(|e| HypenError::StateError(format!("invalid paths JSON: {}", e)))?;
        let values: serde_json::Value = serde_json::from_str(&values_json)
            .map_err(|e| HypenError::StateError(format!("invalid values JSON: {}", e)))?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::StateError(e.to_string()))?;

        let scope = if scope.is_empty() { None } else { Some(scope) };
        // Host-side batch stamping is not exposed over uniffi yet: this
        // method has no animation argument, so it passes `None`. Preludes
        // the engine raises on its own DO now relay (`from_internal` maps
        // `BatchAnimation`); adding an optional animation parameter here is
        // the remaining piece for Kotlin/Swift-initiated stamps.
        if !state
            .core
            .update_state_sparse(scope.as_deref(), &paths, &values, None)
        {
            return Ok(Vec::new());
        }

        let patches = state.core.render_dirty();
        Ok(state.lower_patches(patches))
    }

    /// Set module configuration
    pub fn set_module(&self, config: ModuleConfig) {
        if let Ok(mut state) = self.state.lock() {
            let initial_state: serde_json::Value =
                serde_json::from_str(&config.initial_state_json).unwrap_or(serde_json::Value::Null);
            state.core.set_module(ModuleInstance::from_config(
                &config.name,
                config.actions,
                config.state_keys,
                initial_state,
            ));
        }
    }

    /// Register a named module for multi-module apps.
    /// The engine scopes `${state.xxx}` bindings to this module's state
    /// when rendering a component whose source starts with `module <name> { ... }`.
    pub fn register_module(&self, config: ModuleConfig) {
        if let Ok(mut state) = self.state.lock() {
            let initial_state: serde_json::Value =
                serde_json::from_str(&config.initial_state_json).unwrap_or(serde_json::Value::Null);
            let name = config.name.clone();
            let instance = ModuleInstance::from_config(
                &name,
                config.actions,
                config.state_keys,
                initial_state,
            );
            state.core.register_module(name, instance);
        }
    }

    /// Set (or replace) a named data source context and re-render bound nodes.
    ///
    /// # Arguments
    /// * `name` — provider name (e.g. `"spacetime"`)
    /// * `data_json` — JSON blob representing the entire provider state.
    ///   Passing a non-object is allowed; the engine stores the raw value.
    ///
    /// Mirrors WASI's `hypen_set_context` and JS's `setContext`: the call
    /// auto-renders dirty nodes and returns any resulting patches.
    pub fn set_context(&self, name: String, data_json: String) -> Result<Vec<Patch>, HypenError> {
        let data: serde_json::Value = serde_json::from_str(&data_json)
            .map_err(|e| HypenError::StateError(format!("invalid context JSON: {}", e)))?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::StateError(e.to_string()))?;

        state.core.set_context(&name, data);
        let patches = state.core.render_dirty();
        Ok(state.lower_patches(patches))
    }

    /// Remove a data source context and re-render bound nodes.
    ///
    /// Mirrors WASI's `hypen_remove_context` and JS's `removeContext`: the
    /// call auto-renders dirty nodes and returns any resulting patches.
    pub fn remove_context(&self, name: String) -> Result<Vec<Patch>, HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::StateError(e.to_string()))?;

        state.core.remove_context(&name);
        let patches = state.core.render_dirty();
        Ok(state.lower_patches(patches))
    }

    /// Look up which named module owns an action.
    ///
    /// Returns `Some(module_name)` if the action was registered via
    /// [`register_module`], or `None` if it belongs to the primary module
    /// (via [`set_module`]) or isn't known to the engine. Hosts use this to
    /// route follow-up `update_state` calls to the correct scope after
    /// [`dispatch_action`].
    pub fn action_scope_for(&self, action_name: String) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.core.action_scope_for(&action_name))
    }

    /// Register an action handler name
    pub fn register_action(&self, action_name: String) {
        if let Ok(mut state) = self.state.lock() {
            state.core.note_handler(&action_name);
        }
    }

    /// Dispatch an action (queued for polling)
    pub fn dispatch_action(
        &self,
        action_name: String,
        payload_json: Option<String>,
    ) -> Result<(), HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::ActionError(e.to_string()))?;

        let payload = payload_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| HypenError::ActionError(format!("invalid payload: {e}")))?;
        let mut action = crate::dispatch::Action::new(action_name);
        action.payload = payload;
        let action = state
            .core
            .route_ui_action(action)
            .map_err(|e| HypenError::ActionError(e.to_string()))?;
        if state.core.registered_actions.contains(&action.name) {
            state.pending_actions.push(Action {
                name: action.name,
                payload_json: action.payload.map(|p| p.to_string()),
            });
        }

        Ok(())
    }

    // ── External capability surface ─────────────────────────────────
    //
    // For callers that are NOT the rendered UI. `dispatch_action` above
    // queues any registered action; these guarded entry points accept only
    // what the app declares. Implementation is shared with every other
    // binding via `crate::agent_core`, so the rule cannot drift per SDK.
    // Collections are returned as JSON strings, matching this binding's
    // existing payload convention.

    /// The built-in external action names, as JSON
    /// `{ navigate, back, setInput, bindAction }`.
    ///
    /// Exported so SDKs bind to these rather than hardcoding the literals —
    /// hardcoding is why one rename broke four SDKs silently.
    pub fn external_builtin_names(&self) -> String {
        serde_json::json!({
            "navigate": crate::agent::NAVIGATE,
            "back": crate::agent::BACK,
            "setInput": crate::agent::SET_INPUT,
            "bindAction": crate::agent::BIND_ACTION,
        })
        .to_string()
    }

    /// The full MCP handshake for this app, as a JSON string.
    ///
    /// Composed in the engine so every SDK transports the same bytes rather
    /// than writing its own prose and drifting.
    pub fn mcp_manifest(&self) -> String {
        self.state
            .lock()
            .ok()
            .map(|s| {
                serde_json::to_string(&crate::agent_manifest::mcp_manifest(&s.core))
                    .unwrap_or_else(|_| "null".to_string())
            })
            .unwrap_or_else(|| "null".to_string())
    }

    /// List every action an external caller may dispatch, as a JSON array of
    /// `{ name, module, builtin }`.
    pub fn list_external_actions(&self) -> String {
        self.state
            .lock()
            .ok()
            .map(|s| {
                serde_json::to_string(&crate::agent_core::list_actions(&s.core))
                    .unwrap_or_else(|_| "[]".to_string())
            })
            .unwrap_or_else(|| "[]".to_string())
    }

    /// List declared routes as a JSON array of `{ path, params, moduleScope }`,
    /// backing `navigate`'s argument schema.
    pub fn list_routes(&self) -> String {
        self.state
            .lock()
            .ok()
            .map(|s| {
                serde_json::to_string(&crate::agent_core::list_routes(&s.core))
                    .unwrap_or_else(|_| "[]".to_string())
            })
            .unwrap_or_else(|| "[]".to_string())
    }

    /// List `.bind()`-declared writable inputs as a JSON array of
    /// `{ path, prop, elementType, moduleScope }`, backing `set_input`'s
    /// argument schema.
    pub fn list_bindings(&self) -> String {
        self.state
            .lock()
            .ok()
            .map(|s| {
                serde_json::to_string(&crate::agent_core::list_bindings(&s.core))
                    .unwrap_or_else(|_| "[]".to_string())
            })
            .unwrap_or_else(|| "[]".to_string())
    }

    /// Dispatch on behalf of an external caller.
    ///
    /// Authorises against exactly what `list_external_actions` advertises,
    /// then queues the *resolved* internal action for the host to poll — so
    /// `navigate` arrives as `router.push` and `set_input` as `__hypen_bind`
    /// with a payload built here, never one the caller supplied.
    pub fn dispatch_external(
        &self,
        action_name: String,
        payload_json: Option<String>,
    ) -> Result<(), HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::ActionError(e.to_string()))?;

        let payload: Option<serde_json::Value> = match payload_json.as_deref() {
            None => None,
            Some(raw) => Some(
                serde_json::from_str(raw)
                    .map_err(|e| HypenError::ActionError(format!("invalid payload: {e}")))?,
            ),
        };

        // One construction site for every binding (`agent_core::external_action`);
        // the FFI `Action` carries name + payload JSON only, so the `sender`
        // stamp stays engine-side for now.
        let resolved = crate::agent_core::external_action(&state.core, &action_name, payload, None)
            .map_err(|e| HypenError::ActionError(e.to_string()))?;
        let queued = Action {
            name: resolved.name,
            payload_json: resolved.payload.map(|p| p.to_string()),
        };

        state.pending_actions.push(queued);
        Ok(())
    }

    /// Read module state, whole or at a path, as a JSON string.
    ///
    /// `module` is `None` for the primary module or a registered module's
    /// name (case-insensitive). Returns `None` when the module is unknown or
    /// the path is absent.
    pub fn get_state_at(&self, module: Option<String>, path: Option<String>) -> Option<String> {
        let state = self.state.lock().ok()?;
        crate::agent_core::get_state(&state.core, module.as_deref(), path.as_deref())
            .map(|v| v.to_string())
    }

    /// Drop a module and every action it declared.
    ///
    /// **Call on destroy only**, never on unmount: under the default
    /// `persist: true` an off-screen module stays registered on purpose so
    /// siblings can read its state.
    pub fn unregister_module(&self, name: String) {
        if let Ok(mut state) = self.state.lock() {
            // Snapshot then diff, rather than capturing this scope's names: a
            // scope-match misses the PRIMARY module, whose actions carry scope
            // `None`, so once the shared implementation learned to clear the
            // primary slot a scope-only capture left its `registered_actions`
            // entries behind — still passing `dispatch_action`'s own check
            // after the module was destroyed.
            let before: Vec<String> = state.core.action_module_map.keys().cloned().collect();

            crate::agent_core::unregister_module(&mut state.core, &name);

            let gone: Vec<String> = before
                .into_iter()
                .filter(|a| !state.core.action_module_map.contains_key(a))
                .collect();
            state.core.registered_actions.retain(|a| !gone.contains(a));
        }
    }

    /// Get pending actions (clears the queue)
    pub fn get_pending_actions(&self) -> Vec<Action> {
        if let Ok(mut state) = self.state.lock() {
            std::mem::take(&mut state.pending_actions)
        } else {
            Vec::new()
        }
    }

    /// Get pending imports from the last rendered document (clears the queue)
    /// Call this after render_source() to discover which components need to be resolved.
    /// For each import, use register_component() to provide the resolved component source.
    pub fn get_pending_imports(&self) -> Vec<ImportInfo> {
        if let Ok(mut state) = self.state.lock() {
            std::mem::take(&mut state.pending_imports)
        } else {
            Vec::new()
        }
    }

    /// Register resources from a JSON object: `{ "heart": "<svg>...</svg>", "search": "<svg>...</svg>" }`.
    ///
    /// SDKs should prefer scanning directories themselves (via their native
    /// filesystem APIs) and passing the resulting map through this method.
    /// The engine owns SVG parsing; SDKs are dumb file-readers.
    pub fn register_resources(&self, resources_json: String) -> Result<(), HypenError> {
        let map: indexmap::IndexMap<String, String> = serde_json::from_str(&resources_json)
            .map_err(|e| HypenError::RenderError(format!("Invalid resources JSON: {}", e)))?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::RenderError(e.to_string()))?;

        state.core.register_resources(map);
        Ok(())
    }

    /// Register a single resource from raw SVG content.
    pub fn register_resource(&self, name: String, svg: String) -> Result<(), HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::RenderError(e.to_string()))?;

        state.core.register_resource(&name, &svg);
        Ok(())
    }

    /// Register a primitive element type
    pub fn register_primitive(&self, name: String) {
        if let Ok(mut state) = self.state.lock() {
            state.core.component_registry.register_primitive(&name);
        }
    }

    /// Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
    pub fn register_default_primitives(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.core.component_registry.register_default_primitives();
        }
    }

    /// Return the list of standard Hypen primitive element names.
    pub fn get_default_primitives(&self) -> Vec<String> {
        crate::ir::DEFAULT_PRIMITIVES
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    /// Register a component from source
    pub fn register_component(&self, component: ComponentDef) -> Result<(), HypenError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| HypenError::ComponentError(e.to_string()))?;

        let component_spec = hypen_parser::parse_component(&component.source).map_err(|e| {
            let msg = e
                .iter()
                .map(|err| hypen_parser::error::format_error_simple(err))
                .collect::<Vec<_>>()
                .join("; ");
            HypenError::ParseError(msg)
        })?;

        let ir_node = ast_to_ir_node(&component_spec);
        let ir_element = match ir_node {
            IRNode::Element(e) => e,
            _ => {
                // Root of a component should always be an Element
                return Err(HypenError::ComponentError(
                    "Component root must be an element".to_string(),
                ));
            }
        };
        let is_module = component_spec.declaration_type == hypen_parser::DeclarationType::Module;
        let module_name = if is_module {
            Some(component_spec.name.to_lowercase())
        } else {
            None
        };

        let mut comp = crate::ir::Component::new(component.name, move |_props| ir_element.clone())
            .with_source_path(&component.path);
        if is_module {
            comp.is_module = true;
            comp.module_name = module_name;
        }

        state.core.register_component(comp);

        Ok(())
    }

    /// Clear the render tree
    pub fn clear_tree(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.core.tree.clear();
        }
    }

    /// Get the current revision number
    pub fn get_revision(&self) -> u64 {
        self.state.lock().map(|s| s.core.revision).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_engine() -> Arc<HypenEngine> {
        HypenEngine::new().expect("engine")
    }

    // ── Animation relay across the uniffi boundary ───────────────────────
    //
    // These pin the two fields mobile SDKs need to defer removes and honor
    // transaction stamps. They are the Rust half of a contract whose other
    // half lives in generated Kotlin/Swift, so they assert on exact values,
    // not just "something came through".

    #[test]
    fn test_flagged_remove_carries_transition() {
        let patch = Patch::from_internal(InternalPatch::Remove {
            id: "n7".into(),
            transition: true,
        });

        assert!(matches!(patch.patch_type, PatchType::Remove));
        assert_eq!(patch.id, "n7");
        assert!(
            patch.transition,
            "an exit-animated removal root must arrive flagged; dropping it is \
             what forced mobile renderers to snap"
        );
        assert_eq!(patch.spec_json, None);
    }

    #[test]
    fn test_unflagged_remove_is_unchanged() {
        let patch = Patch::from_internal(InternalPatch::Remove {
            id: "n7".into(),
            transition: false,
        });

        assert!(matches!(patch.patch_type, PatchType::Remove));
        assert_eq!(patch.id, "n7");
        assert!(
            !patch.transition,
            "plain removals must stay false — matches the wire default, so \
             relays re-serialize byte-identically to the pre-flag protocol"
        );
        // Every other slot stays empty, exactly as before the field existed.
        assert_eq!(patch.element_type, None);
        assert_eq!(patch.props_json, None);
        assert_eq!(patch.name, None);
        assert_eq!(patch.value_json, None);
        assert_eq!(patch.text, None);
        assert_eq!(patch.parent_id, None);
        assert_eq!(patch.before_id, None);
        assert_eq!(patch.semantics_json, None);
        assert_eq!(patch.spec_json, None);
    }

    #[test]
    fn test_batch_animation_survives_as_spec_json() {
        let spec = serde_json::json!({ "curve": "spring", "duration": 250 });
        let patch = Patch::from_internal(InternalPatch::BatchAnimation { spec: spec.clone() });

        assert!(matches!(patch.patch_type, PatchType::BatchAnimation));
        // The prelude addresses no node: hosts must route on patch_type.
        assert_eq!(patch.id, "");
        assert!(!patch.transition);

        let round_tripped: serde_json::Value =
            serde_json::from_str(patch.spec_json.as_deref().expect("spec_json present"))
                .expect("spec_json must be valid JSON for consumers to parse");
        assert_eq!(
            round_tripped, spec,
            "the spec must survive stringification unchanged — unknown fields \
             included; renderers own interpretation"
        );
    }

    #[test]
    fn test_no_patch_variant_is_dropped_at_the_boundary() {
        // `from_internal` is total. If a future variant is added and mapped
        // to a silent drop, this catches it — a dropped patch is invisible
        // to Kotlin/Swift hosts and to any browser client they relay to.
        let internal = vec![
            InternalPatch::BatchAnimation {
                spec: serde_json::json!({ "curve": "linear", "duration": 100 }),
            },
            InternalPatch::Create {
                id: "n1".into(),
                element_type: "text".to_string(),
                props: Default::default(),
                semantics: None,
            },
            InternalPatch::SetProp {
                id: "n1".into(),
                name: "0".to_string(),
                value: serde_json::json!("hi"),
            },
            InternalPatch::RemoveProp {
                id: "n1".into(),
                name: "0".to_string(),
            },
            InternalPatch::SetText {
                id: "n1".into(),
                text: "hi".to_string(),
            },
            InternalPatch::SetSemantics {
                id: "n1".into(),
                semantics: None,
            },
            InternalPatch::Insert {
                parent_id: "root".into(),
                id: "n1".into(),
                before_id: None,
            },
            InternalPatch::Move {
                parent_id: "root".into(),
                id: "n1".into(),
                before_id: None,
            },
            InternalPatch::Remove {
                id: "n1".into(),
                transition: true,
            },
            InternalPatch::Detach { id: "n1".into() },
            InternalPatch::Attach {
                parent_id: "root".into(),
                id: "n1".into(),
                before_id: None,
            },
        ];
        let count = internal.len();

        let converted: Vec<Patch> = internal.into_iter().map(Patch::from_internal).collect();
        assert_eq!(
            converted.len(),
            count,
            "every engine patch variant must cross the uniffi boundary"
        );
        // The prelude must stay first — it is only a stamp at batch index 0.
        assert!(matches!(converted[0].patch_type, PatchType::BatchAnimation));
    }

    #[test]
    fn test_set_and_remove_context_roundtrip() {
        let engine = make_engine();
        engine.register_default_primitives();

        // set_context with a fresh provider should succeed even without any
        // bindings registered (no dirty nodes, empty patch list).
        let patches = engine
            .set_context(
                "spacetime".to_string(),
                r#"{"user":{"name":"Alice"}}"#.to_string(),
            )
            .expect("set_context");
        assert!(patches.is_empty(), "no bound nodes → no patches yet");

        // Invalid JSON surfaces as a StateError.
        let err = engine
            .set_context("spacetime".to_string(), "not json".to_string())
            .expect_err("invalid JSON should error");
        matches!(err, HypenError::StateError(_));

        // remove_context on an unknown provider is a no-op but still succeeds.
        let patches = engine
            .remove_context("unknown".to_string())
            .expect("remove_context");
        assert!(patches.is_empty());

        // Removing the registered one works too.
        let patches = engine
            .remove_context("spacetime".to_string())
            .expect("remove_context");
        assert!(patches.is_empty());
    }

    #[test]
    fn test_action_scope_for_set_module_returns_none() {
        let engine = make_engine();
        engine.set_module(ModuleConfig {
            name: "Counter".to_string(),
            actions: vec!["increment".to_string(), "decrement".to_string()],
            state_keys: vec![],
            initial_state_json: "{}".to_string(),
        });

        // Primary-slot actions report `None` scope (correct routing signal
        // for polling bindings — they use the primary slot for follow-up
        // update_state calls).
        assert_eq!(engine.action_scope_for("increment".to_string()), None);
        assert_eq!(engine.action_scope_for("decrement".to_string()), None);
    }

    #[test]
    fn test_action_scope_for_register_module_returns_scope() {
        let engine = make_engine();
        engine.register_module(ModuleConfig {
            name: "search".to_string(),
            actions: vec!["submit".to_string()],
            state_keys: vec![],
            initial_state_json: "{}".to_string(),
        });

        assert_eq!(
            engine.action_scope_for("submit".to_string()),
            Some("search".to_string())
        );
        assert_eq!(engine.action_scope_for("unknown".to_string()), None);
    }

    #[test]
    fn test_set_context_invalidates_deep_binding() {
        // End-to-end check: render a component that binds to `@ds.user.name`,
        // then replace the provider and confirm a patch carrying the new
        // value is returned.
        let engine = make_engine();
        engine.register_default_primitives();
        engine.set_module(ModuleConfig {
            name: "Page".to_string(),
            actions: vec![],
            state_keys: vec![],
            initial_state_json: "{}".to_string(),
        });

        engine
            .set_context(
                "spacetime".to_string(),
                r#"{"user":{"name":"Alice"}}"#.to_string(),
            )
            .expect("seed context");

        let _ = engine
            .render_source(r#"Text("@{spacetime.user.name}")"#.to_string())
            .expect("render");

        let patches = engine
            .set_context(
                "spacetime".to_string(),
                r#"{"user":{"name":"Bob"}}"#.to_string(),
            )
            .expect("replace context");

        // We should observe at least one patch referencing "Bob" — the deep
        // binding must invalidate when the whole provider is replaced.
        let saw_bob = patches.iter().any(|p| {
            p.text.as_deref() == Some("Bob")
                || p.value_json
                    .as_deref()
                    .map(|s| s.contains("Bob"))
                    .unwrap_or(false)
                || p.props_json
                    .as_deref()
                    .map(|s| s.contains("Bob"))
                    .unwrap_or(false)
        });
        assert!(
            saw_bob,
            "expected a patch carrying 'Bob' after set_context replaced the deep provider state; got: {:?}",
            patches
        );
    }
}
