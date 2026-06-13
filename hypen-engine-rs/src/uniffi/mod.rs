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
//! # Generate Kotlin bindings
//! cargo run --features uniffi --bin uniffi-bindgen generate \
//!     --library target/release/libhypen_engine.so \
//!     --language kotlin \
//!     --out-dir ../hypen-kotlin/src/main/kotlin
//! ```

use std::sync::{Arc, Mutex};

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
}

impl From<InternalPatch> for Patch {
    fn from(p: InternalPatch) -> Self {
        match p {
            InternalPatch::Create {
                id,
                element_type,
                props,
            } => Patch {
                patch_type: PatchType::Create,
                id,
                element_type: Some(element_type),
                props_json: Some(serde_json::to_string(&*props).unwrap_or_default()),
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
            },
            InternalPatch::SetProp { id, name, value } => Patch {
                patch_type: PatchType::SetProp,
                id,
                element_type: None,
                props_json: None,
                name: Some(name),
                value_json: Some(serde_json::to_string(&value).unwrap_or_default()),
                text: None,
                parent_id: None,
                before_id: None,
            },
            InternalPatch::RemoveProp { id, name } => Patch {
                patch_type: PatchType::RemoveProp,
                id,
                element_type: None,
                props_json: None,
                name: Some(name),
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
            },
            InternalPatch::SetText { id, text } => Patch {
                patch_type: PatchType::SetText,
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: Some(text),
                parent_id: None,
                before_id: None,
            },
            InternalPatch::Insert {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Insert,
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id),
                before_id,
            },
            InternalPatch::Move {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Move,
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id),
                before_id,
            },
            InternalPatch::Remove { id } => Patch {
                patch_type: PatchType::Remove,
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
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
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: None,
                before_id: None,
            },
            InternalPatch::Attach {
                parent_id,
                id,
                before_id,
            } => Patch {
                patch_type: PatchType::Attach,
                id,
                element_type: None,
                props_json: None,
                name: None,
                value_json: None,
                text: None,
                parent_id: Some(parent_id),
                before_id,
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

        Ok(patches.into_iter().map(Patch::from).collect())
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
        if !state.core.update_state(scope.as_deref(), patch) {
            return Ok(Vec::new());
        }

        let patches = state.core.render_dirty();
        Ok(patches.into_iter().map(Patch::from).collect())
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
        if !state
            .core
            .update_state_sparse(scope.as_deref(), &paths, &values)
        {
            return Ok(Vec::new());
        }

        let patches = state.core.render_dirty();
        Ok(patches.into_iter().map(Patch::from).collect())
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
        Ok(patches.into_iter().map(Patch::from).collect())
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
        Ok(patches.into_iter().map(Patch::from).collect())
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
            state.core.registered_actions.push(action_name);
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

        if state.core.registered_actions.contains(&action_name) {
            state.pending_actions.push(Action {
                name: action_name,
                payload_json,
            });
        }

        Ok(())
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
