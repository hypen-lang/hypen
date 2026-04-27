//! JavaScript/WASM bindings for Hypen Engine
//!
//! This module provides JavaScript-specific bindings via wasm-bindgen.
//! For WASI/non-JS runtimes, see the `wasi` module.

use serde_wasm_bindgen::from_value;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

/// Static null value to avoid cloning state when no module exists
static NULL_STATE: serde_json::Value = serde_json::Value::Null;

/// Create a structured JS error object that consumers can programmatically inspect.
///
/// Returns a JS object: `{ type: "<errorType>", message: "<humanReadable>" }`
///
/// Error types: `"parseError"`, `"stateError"`, `"actionError"`, `"renderError"`, `"componentError"`
fn structured_error(error_type: &str, message: &str) -> JsValue {
    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"type".into(), &JsValue::from_str(error_type));
    let _ = js_sys::Reflect::set(&obj, &"message".into(), &JsValue::from_str(message));
    obj.into()
}

use crate::{
    dispatch::Action,
    engine_core::EngineCore,
    ir::{ast_to_ir_node, Element, IRNode},
    lifecycle::ModuleInstance,
    reconcile::Patch,
    wasm::shared::{format_parse_errors, render_subtree_into, NodeIdIndex},
};

/// The main Hypen engine interface for JavaScript/WASM runtimes.
///
/// `WasmEngine` manages the full lifecycle of a Hypen UI: parsing DSL source,
/// maintaining the virtual tree, tracking reactive dependencies, and emitting
/// minimal patches when state changes. It runs in a single-threaded WASM
/// environment (browsers, Node.js, Bun, Deno).
///
/// # Quick Start
///
/// ```js
/// import { WasmEngine } from "@hypen-space/core";
///
/// const engine = new WasmEngine();
///
/// // 1. Register primitives so the engine doesn't try to resolve them as components
/// engine.registerPrimitive("Text");
/// engine.registerPrimitive("Column");
///
/// // 2. Receive patches via callback
/// engine.setRenderCallback((patches) => {
///     for (const patch of patches) {
///         applyPatch(patch); // Create, SetProp, Insert, Remove, etc.
///     }
/// });
///
/// // 3. Optionally set up a module for stateful UI
/// engine.setModule("Counter", ["increment"], ["count"], { count: 0 });
///
/// // 4. Render DSL source — patches are emitted via the callback
/// engine.renderSource('Column { Text("Count: @{state.count}") }');
///
/// // 5. Update state — only affected nodes are re-rendered
/// engine.updateState({ count: 1 });
/// ```
///
/// # Patch Protocol
///
/// All UI mutations are expressed as [`Patch`] values emitted through the render
/// callback. Patches use camelCase field names for direct JavaScript consumption.
/// See [`Patch`] for the full variant list and field documentation.
///
/// # Component Resolution
///
/// Custom components (anything not registered as a primitive) are resolved lazily
/// via the component resolver callback set with [`set_component_resolver`]. The
/// resolver receives `(componentName, contextPath)` and should return
/// `{ source: string, path: string }` or `null`.
///
/// # Revision Tracking
///
/// Every render cycle (initial render or state update that produces patches)
/// increments the revision counter. Use [`get_revision`] to detect stale state
/// in async workflows.
#[wasm_bindgen]
pub struct WasmEngine {
    /// Shared core: component registry, resource registry, module state,
    /// instance tree, dependency graph, scheduler, data sources, etc.
    core: EngineCore,

    patch_callback: Option<js_sys::Function>,
    action_handlers: std::collections::HashMap<String, js_sys::Function>,
    component_resolver: Option<js_sys::Function>,
    /// Tracks visited import paths to prevent circular imports during resolution
    import_visited: HashSet<String>,
    /// Index from compact node-ID strings back to their SlotMap keys,
    /// populated from emitted `Create` patches. Shared with the WASI
    /// binding (see `wasm::shared::NodeIdIndex`).
    node_id_index: NodeIdIndex,

    /// Callback for data source actions (e.g., @actions.spacetime.sendMessage).
    /// Receives `{ provider, method, payload }` when a data source action is dispatched
    /// and no explicit handler is registered for the full action name.
    data_source_action_handler: Option<js_sys::Function>,
}

#[wasm_bindgen]
impl WasmEngine {
    /// Create a new engine instance with an empty tree and no module.
    ///
    /// After construction, you typically:
    /// 1. Register primitives with [`register_primitive`]
    /// 2. Set a render callback with [`set_render_callback`]
    /// 3. Optionally set a component resolver with [`set_component_resolver`]
    /// 4. Optionally initialize a module with [`set_module`]
    /// 5. Render source with [`render_source`]
    #[allow(clippy::new_without_default)]
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        // Enable console_error_panic_hook for better debugging
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self {
            core: EngineCore::new(),
            patch_callback: None,
            action_handlers: std::collections::HashMap::new(),
            component_resolver: None,
            import_visited: HashSet::new(),
            node_id_index: NodeIdIndex::new(),
            data_source_action_handler: None,
        }
    }

    /// Parse and render Hypen DSL source code, emitting patches via the render callback.
    ///
    /// Supports full document syntax including `import` statements. Imports are
    /// resolved synchronously through the component resolver callback (if set).
    ///
    /// This performs a **full reconciliation** -- the existing tree is diffed against
    /// the new IR and minimal patches are emitted. Calling this multiple times with
    /// different source replaces the previous UI.
    ///
    /// # Errors
    ///
    /// Returns a `JsValue` string error if the source fails to parse.
    #[wasm_bindgen(js_name = renderSource)]
    pub fn render_source(&mut self, source: &str) -> Result<(), JsValue> {
        let doc = hypen_parser::parse_document(source)
            .map_err(|e| structured_error("parseError", &format_parse_errors(&e)))?;

        // Pre-resolve imported components before rendering
        self.import_visited.clear();
        self.resolve_imports(&doc.imports);

        // Render the first component (entry point)
        if let Some(component) = doc.components.first() {
            let ir_node = ast_to_ir_node(component);
            self.render(&ir_node);
        }

        Ok(())
    }

    /// Set the callback that receives UI patches after each render cycle.
    #[wasm_bindgen(js_name = setRenderCallback)]
    pub fn set_render_callback(&mut self, callback: js_sys::Function) {
        self.patch_callback = Some(callback);
    }

    /// Set the component resolver callback
    #[wasm_bindgen(js_name = setComponentResolver)]
    pub fn set_component_resolver(&mut self, resolver: js_sys::Function) {
        self.component_resolver = Some(resolver);
    }

    /// Register a primitive element (like Text, Button, etc.) to skip component resolution
    #[wasm_bindgen(js_name = registerPrimitive)]
    pub fn register_primitive(&mut self, name: &str) {
        self.core.component_registry.register_primitive(name);
    }

    /// Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
    #[wasm_bindgen(js_name = registerDefaultPrimitives)]
    pub fn register_default_primitives(&mut self) {
        self.core.component_registry.register_default_primitives();
    }

    /// Clear resolved components and caches, preserving primitives and resolver.
    #[wasm_bindgen(js_name = clearResolvedComponents)]
    pub fn clear_resolved_components(&mut self) {
        self.core.component_registry.clear_resolved();
    }

    /// Parse a DSL source and return every `Router { Route ... }` block
    /// it contains, for SDKs that want to auto-wire a ManagedRouter
    /// against the template without making the user repeat the route
    /// table. Returns `[{ moduleScope, routes: [{ path, elementNames }] }]`
    /// — `elementNames` is BFS-ordered so the SDK can pick the first
    /// name that matches a registered module.
    #[wasm_bindgen(js_name = discoverRouters)]
    pub fn discover_routers(&self, source: &str) -> Result<JsValue, JsValue> {
        let doc = hypen_parser::parse_document(source)
            .map_err(|e| structured_error("parseError", &format_parse_errors(&e)))?;
        let mut routers = Vec::new();
        for component in &doc.components {
            let ir = crate::ir::ast_to_ir_node(component);
            routers.extend(crate::ir::discover_routers(&ir));
        }
        serde_wasm_bindgen::to_value(&routers)
            .map_err(|e| structured_error("serializeError", &format!("{}", e)))
    }

    /// Register resources from a JavaScript object (name -> SVG string map).
    #[wasm_bindgen(js_name = registerResources)]
    pub fn register_resources(&mut self, resources_js: JsValue) -> Result<(), JsValue> {
        let map: indexmap::IndexMap<String, String> = from_value(resources_js)
            .map_err(|e| structured_error("resourceError", &format!("Invalid resources: {}", e)))?;

        #[cfg(debug_assertions)]
        web_sys::console::log_1(
            &format!("[WASM] Registered {} resources", map.len()).into(),
        );

        self.core.resource_registry.register_map(map);
        Ok(())
    }

    /// Render a component source on-demand (for lazy-loaded routes).
    #[wasm_bindgen(js_name = renderLazyComponent)]
    pub fn render_lazy_component(&mut self, source: &str) -> Result<(), JsValue> {
        self.render_source(source)
    }

    /// Render a component into a specific parent node (subtree rendering)
    #[wasm_bindgen(js_name = renderInto)]
    pub fn render_into(
        &mut self,
        source: &str,
        parent_node_id_str: &str,
        state_js: JsValue,
    ) -> Result<(), JsValue> {
        let doc = hypen_parser::parse_document(source)
            .map_err(|e| structured_error("parseError", &format_parse_errors(&e)))?;

        self.import_visited.clear();
        self.resolve_imports(&doc.imports);

        let component = doc
            .components
            .first()
            .ok_or_else(|| structured_error("parseError", "No component found in source"))?;

        let ir_node = ast_to_ir_node(component);
        self.resolve_ir_node_components(&ir_node);

        let mut expanded = self.core.component_registry.expand_ir_node(&ir_node);

        if !self.core.resource_registry.is_empty() {
            crate::ir::resolve_icons_in_ir(&self.core.resource_registry, &mut expanded);
        }

        let state: serde_json::Value = if state_js.is_null() || state_js.is_undefined() {
            serde_json::Value::Null
        } else {
            from_value(state_js).map_err(|e| structured_error("stateError", &e.to_string()))?
        };

        let parent_id = self.node_id_index.lookup(parent_node_id_str).ok_or_else(|| {
            structured_error(
                "renderError",
                &format!("Parent node not found: {}", parent_node_id_str),
            )
        })?;

        #[cfg(debug_assertions)]
        web_sys::console::log_1(
            &format!("[WASM] Rendering into parent node: {}", parent_node_id_str).into(),
        );

        let mut patches = Vec::new();
        render_subtree_into(&mut self.core, parent_id, &expanded, &state, &mut patches);
        self.emit_patches(patches);

        Ok(())
    }

    /// Internal render method using IRNode.
    /// Delegates to `EngineCore::render_ir_node` for the shared
    /// expand-reconcile-patch pipeline, then emits patches via the JS callback.
    fn render(&mut self, ir_node: &IRNode) {
        self.resolve_ir_node_components(ir_node);
        let patches = self.core.render_ir_node(ir_node);
        self.emit_patches(patches);
    }

    /// Pre-resolve imported components via the JS resolver callback.
    fn resolve_imports(&mut self, imports: &[hypen_parser::ImportStatement]) {
        let resolver = match self.component_resolver.clone() {
            Some(r) => r,
            None => return,
        };

        for import in imports {
            let source_path = import.source_path();

            for name in import.imported_names() {
                if self
                    .core.component_registry
                    .get(&name, Some(source_path))
                    .is_some()
                {
                    continue;
                }

                let import_key = format!("{}:{}", source_path, name);
                if self.import_visited.contains(&import_key) {
                    continue;
                }
                self.import_visited.insert(import_key);

                let name_js = JsValue::from_str(&name);
                let source_path_js = JsValue::from_str(source_path);

                if let Ok(result) = resolver.call2(&JsValue::NULL, &name_js, &source_path_js) {
                    if result.is_null() || result.is_undefined() {
                        continue;
                    }

                    let source_val =
                        js_sys::Reflect::get(&result, &JsValue::from_str("source")).ok();
                    let path_val = js_sys::Reflect::get(&result, &JsValue::from_str("path")).ok();
                    let passthrough_val =
                        js_sys::Reflect::get(&result, &JsValue::from_str("passthrough")).ok();
                    let lazy_val = js_sys::Reflect::get(&result, &JsValue::from_str("lazy")).ok();

                    if let (Some(source_js), Some(path_js)) = (source_val, path_val) {
                        if let (Some(resolved_source), Some(path)) =
                            (source_js.as_string(), path_js.as_string())
                        {
                            let is_lazy = lazy_val.and_then(|v| v.as_bool()).unwrap_or(false);
                            let is_passthrough =
                                passthrough_val.and_then(|v| v.as_bool()).unwrap_or(false);

                            if is_lazy {
                                let dummy_element = Element::new(&name);
                                let component =
                                    crate::ir::Component::new(name.clone(), move |_props| {
                                        dummy_element.clone()
                                    })
                                    .with_source_path(&path)
                                    .with_lazy(true);
                                self.core.component_registry.register(component);
                            } else if is_passthrough {
                                let dummy_element = Element::new(&name);
                                let component =
                                    crate::ir::Component::new(name.clone(), move |_props| {
                                        dummy_element.clone()
                                    })
                                    .with_source_path(&path)
                                    .with_passthrough(true);
                                self.core.component_registry.register(component);
                            } else {
                                if let Ok(resolved_doc) =
                                    hypen_parser::parse_document(&resolved_source)
                                {
                                    self.resolve_imports(&resolved_doc.imports);

                                    if let Some(component_spec) = resolved_doc.components.first() {
                                        let ir_node = ast_to_ir_node(component_spec);
                                        if let IRNode::Element(ir_element) = &ir_node {
                                            let ir_element = ir_element.clone();
                                            let component = crate::ir::Component::new(
                                                name.clone(),
                                                move |_props| ir_element.clone(),
                                            )
                                            .with_source_path(&path);
                                            self.core.component_registry.register(component);
                                        }

                                        self.resolve_ir_node_components_with_context(
                                            &ir_node,
                                            Some(&path),
                                        );
                                    }
                                } else if let Ok(component_spec) =
                                    hypen_parser::parse_component(&resolved_source)
                                {
                                    let ir_node = ast_to_ir_node(&component_spec);
                                    if let IRNode::Element(ir_element) = &ir_node {
                                        let ir_element = ir_element.clone();
                                        let component =
                                            crate::ir::Component::new(name.clone(), move |_props| {
                                                ir_element.clone()
                                            })
                                            .with_source_path(&path);
                                        self.core.component_registry.register(component);
                                    }

                                    self.resolve_ir_node_components_with_context(
                                        &ir_node,
                                        Some(&path),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Recursively resolve components with path context
    fn resolve_components_with_context(&mut self, element: &Element, context_path: Option<&str>) {
        if self.core.component_registry.is_primitive(&element.element_type) {
            for child_ir in &element.ir_children {
                if let IRNode::Element(child) = child_ir {
                    self.resolve_components_with_context(child, context_path);
                }
            }
            return;
        }

        if self
            .core.component_registry
            .get(&element.element_type, context_path)
            .is_none()
        {
            if let Some(ref resolver) = self.component_resolver.clone() {
                let name_js = JsValue::from_str(&element.element_type);
                let context_js = context_path.map(JsValue::from_str).unwrap_or(JsValue::NULL);

                if let Ok(result) = resolver.call2(&JsValue::NULL, &name_js, &context_js) {
                    if !result.is_null() && !result.is_undefined() {
                        let source_val =
                            js_sys::Reflect::get(&result, &JsValue::from_str("source")).ok();
                        let path_val =
                            js_sys::Reflect::get(&result, &JsValue::from_str("path")).ok();
                        let passthrough_val =
                            js_sys::Reflect::get(&result, &JsValue::from_str("passthrough")).ok();
                        let lazy_val =
                            js_sys::Reflect::get(&result, &JsValue::from_str("lazy")).ok();

                        if let (Some(source_js), Some(path_js)) = (source_val, path_val) {
                            if let (Some(source), Some(path)) =
                                (source_js.as_string(), path_js.as_string())
                            {
                                let is_lazy = lazy_val.and_then(|v| v.as_bool()).unwrap_or(false);
                                let is_passthrough =
                                    passthrough_val.and_then(|v| v.as_bool()).unwrap_or(false);

                                if is_lazy {
                                    #[cfg(debug_assertions)]
                                    web_sys::console::log_1(
                                        &format!(
                                            "[WASM] Registering lazy component: {}",
                                            element.element_type
                                        )
                                        .into(),
                                    );

                                    let name = element.element_type.clone();
                                    let dummy_element = Element::new(&name);
                                    let component =
                                        crate::ir::Component::new(name.clone(), move |_props| {
                                            dummy_element.clone()
                                        })
                                        .with_source_path(&path)
                                        .with_lazy(true);

                                    self.core.component_registry.register(component);
                                } else if is_passthrough {
                                    #[cfg(debug_assertions)]
                                    web_sys::console::log_1(
                                        &format!(
                                            "[WASM] Registering passthrough component: {}",
                                            element.element_type
                                        )
                                        .into(),
                                    );

                                    let name = element.element_type.clone();
                                    let dummy_element = Element::new(&name);
                                    let component =
                                        crate::ir::Component::new(name.clone(), move |_props| {
                                            dummy_element.clone()
                                        })
                                        .with_source_path(&path)
                                        .with_passthrough(true);

                                    self.core.component_registry.register(component);
                                } else {
                                    if let Ok(component_spec) =
                                        hypen_parser::parse_component(&source)
                                    {
                                        let ir_node = ast_to_ir_node(&component_spec);
                                        let name = element.element_type.clone();
                                        let path_clone = path.clone();

                                        if let IRNode::Element(ir_element) = &ir_node {
                                            let ir_element = ir_element.clone();
                                            let spec_is_module = component_spec.declaration_type
                                                == hypen_parser::DeclarationType::Module;
                                            let spec_module_name = if spec_is_module {
                                                Some(component_spec.name.to_lowercase())
                                            } else {
                                                None
                                            };

                                            let mut component = crate::ir::Component::new(
                                                name.clone(),
                                                move |_props| ir_element.clone(),
                                            )
                                            .with_source_path(&path);

                                            if spec_is_module {
                                                component.is_module = true;
                                                component.module_name = spec_module_name;
                                            }

                                            self.core.component_registry.register(component);
                                        }

                                        self.resolve_ir_node_components_with_context(
                                            &ir_node,
                                            Some(&path_clone),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        for child_ir in &element.ir_children {
            if let IRNode::Element(child) = child_ir {
                self.resolve_components_with_context(child, context_path);
            }
        }
    }

    /// Recursively resolve components in an IRNode using the JS resolver
    fn resolve_ir_node_components(&mut self, node: &IRNode) {
        self.resolve_ir_node_components_with_context(node, None);
    }

    /// Recursively resolve components in an IRNode with path context
    fn resolve_ir_node_components_with_context(
        &mut self,
        node: &IRNode,
        context_path: Option<&str>,
    ) {
        match node {
            IRNode::Element(element) => {
                self.resolve_components_with_context(element, context_path);
                for child in &element.ir_children {
                    self.resolve_ir_node_components_with_context(child, context_path);
                }
            }
            IRNode::ForEach { template, .. } => {
                for child in template {
                    self.resolve_ir_node_components_with_context(child, context_path);
                }
            }
            IRNode::Conditional {
                branches, fallback, ..
            } => {
                for branch in branches {
                    for child in &branch.children {
                        self.resolve_ir_node_components_with_context(child, context_path);
                    }
                }
                if let Some(fb) = fallback {
                    for child in fb {
                        self.resolve_ir_node_components_with_context(child, context_path);
                    }
                }
            }
            IRNode::Router {
                routes, fallback, ..
            } => {
                for route in routes {
                    for child in &route.children {
                        self.resolve_ir_node_components_with_context(child, context_path);
                    }
                }
                if let Some(fb) = fallback {
                    for child in fb {
                        self.resolve_ir_node_components_with_context(child, context_path);
                    }
                }
            }
        }
    }

    /// Emit patches to the callback.
    /// Filters spurious removes, indexes newly created node IDs, and
    /// serializes patches to JS via the render callback.
    fn emit_patches(&mut self, mut patches: Vec<Patch>) {
        EngineCore::filter_spurious_removes(&mut patches);
        self.node_id_index.index_creates(&patches, &self.core);

        if let Some(ref callback) = self.patch_callback {
            let serializer = serde_wasm_bindgen::Serializer::json_compatible();
            if let Ok(patches_js) = serde::Serialize::serialize(&patches, &serializer) {
                let _ = callback.call1(&JsValue::NULL, &patches_js);
            }
        }
    }

    /// Apply a state patch and re-render affected nodes.
    ///
    /// `scope` selects the target module:
    /// - empty string / null / undefined → primary module set via [`set_module`](Self::set_module)
    /// - any other string → named module registered via [`register_module`] (lowercased)
    #[wasm_bindgen(js_name = updateState)]
    pub fn update_state(&mut self, scope: Option<String>, state_patch: JsValue) -> Result<(), JsValue> {
        let patch: serde_json::Value = from_value(state_patch)
            .map_err(|e| structured_error("stateError", &format!("Invalid state patch: {}", e)))?;

        let normalized = scope.as_deref().filter(|s| !s.is_empty());
        if self.core.update_state(normalized, patch) {
            self.render_dirty();
        }
        Ok(())
    }

    /// Apply a sparse state update using explicit path-value pairs.
    /// See [`update_state`] for `scope` semantics.
    #[wasm_bindgen(js_name = updateStateSparse)]
    pub fn update_state_sparse(
        &mut self,
        scope: Option<String>,
        paths_js: JsValue,
        values_js: JsValue,
    ) -> Result<(), JsValue> {
        let paths: Vec<String> = from_value(paths_js)
            .map_err(|e| structured_error("stateError", &format!("Invalid paths array: {}", e)))?;

        let values: serde_json::Value = from_value(values_js).map_err(|e| {
            structured_error("stateError", &format!("Invalid values object: {}", e))
        })?;

        let normalized = scope.as_deref().filter(|s| !s.is_empty());
        if self.core.update_state_sparse(normalized, &paths, &values) {
            self.render_dirty();
        }
        Ok(())
    }

    /// Render only dirty nodes (optimized for state changes).
    fn render_dirty(&mut self) {
        let patches = self.core.render_dirty();
        if !patches.is_empty() {
            self.emit_patches(patches);
        }
    }

    // ── Data Source Context ─────────────────────────────────────────

    /// Set (or replace) a named data source context.
    #[wasm_bindgen(js_name = setContext)]
    pub fn set_context(&mut self, name: &str, data_js: JsValue) -> Result<(), JsValue> {
        let data: serde_json::Value = from_value(data_js).map_err(|e| {
            structured_error(
                "stateError",
                &format!("Invalid context data: {}", e),
            )
        })?;

        self.core.set_context(name, data);
        self.render_dirty();
        Ok(())
    }

    /// Remove a data source context entirely.
    #[wasm_bindgen(js_name = removeContext)]
    pub fn remove_context(&mut self, name: &str) {
        self.core.remove_context(name);
        self.render_dirty();
    }

    // ── Actions ─────────────────────────────────────────────────────

    /// Dispatch a named action, invoking the registered handler (if any).
    #[wasm_bindgen(js_name = dispatchAction)]
    pub fn dispatch_action(&mut self, name: &str, payload: JsValue) -> Result<(), JsValue> {
        let payload: Option<serde_json::Value> = if payload.is_undefined() || payload.is_null() {
            None
        } else {
            Some(from_value(payload).map_err(|e| {
                structured_error("actionError", &format!("Invalid action payload: {}", e))
            })?)
        };

        let payload = payload.unwrap_or(serde_json::Value::Null);

        // 1. Try exact handler match first
        if let Some(handler) = self.action_handlers.get(name) {
            let action = Action::new(name).with_payload(payload);
            let serializer = serde_wasm_bindgen::Serializer::json_compatible();
            if let Ok(action_js) = serde::Serialize::serialize(&action, &serializer) {
                let _ = handler.call1(&JsValue::NULL, &action_js);
            }
            return Ok(());
        }

        // 2. Fall through to the shared data-source classifier on EngineCore.
        if let Some(ds_action) = self.core.build_data_source_action(name, payload) {
            if let Some(ref handler) = self.data_source_action_handler {
                let serializer = serde_wasm_bindgen::Serializer::json_compatible();
                if let Ok(action_js) = serde::Serialize::serialize(&ds_action, &serializer) {
                    let _ = handler.call1(&JsValue::NULL, &action_js);
                }
            }
        }

        Ok(())
    }

    /// Register a JavaScript function as the handler for a named action.
    #[wasm_bindgen(js_name = onAction)]
    pub fn on_action(&mut self, action_name: &str, handler: js_sys::Function) {
        self.action_handlers
            .insert(action_name.to_string(), handler);
    }

    /// Register a handler for data source actions.
    #[wasm_bindgen(js_name = onDataSourceAction)]
    pub fn on_data_source_action(&mut self, handler: js_sys::Function) {
        self.data_source_action_handler = Some(handler);
    }

    /// Remove all nodes from the instance tree without emitting Remove patches.
    #[wasm_bindgen(js_name = clearTree)]
    pub fn clear_tree(&mut self) {
        self.core.tree.clear();
    }

    /// Parse a component and return a human-readable debug string.
    #[wasm_bindgen(js_name = debugParseComponent)]
    pub fn debug_parse_component(&self, source: &str) -> Result<String, JsValue> {
        let component = hypen_parser::parse_component(source)
            .map_err(|e| structured_error("parseError", &format_parse_errors(&e)))?;

        let debug_info = format!(
            "Name: {} | DeclarationType: {:?} | Children: {} | Applicators: {}",
            component.name,
            component.declaration_type,
            component.children.len(),
            component.applicators.len(),
        );

        Ok(debug_info)
    }

    /// Initialize (or replace) the active module with the given configuration.
    #[wasm_bindgen(js_name = setModule)]
    pub fn set_module(
        &mut self,
        name: &str,
        actions: Vec<String>,
        state_keys: Vec<String>,
        initial_state: JsValue,
    ) -> Result<(), JsValue> {
        let state: serde_json::Value = from_value(initial_state).map_err(|e| {
            structured_error("stateError", &format!("Invalid initial state: {}", e))
        })?;

        let instance = ModuleInstance::from_config(name, actions, state_keys, state);
        self.core.set_module(instance);

        Ok(())
    }

    /// Register a named module for multi-module apps.
    #[wasm_bindgen(js_name = registerModule)]
    pub fn register_module(
        &mut self,
        name: &str,
        actions: Vec<String>,
        state_keys: Vec<String>,
        initial_state: JsValue,
    ) -> Result<(), JsValue> {
        let state: serde_json::Value = from_value(initial_state).map_err(|e| {
            structured_error("stateError", &format!("Invalid initial state: {}", e))
        })?;

        let instance = ModuleInstance::from_config(name, actions, state_keys, state);
        // EngineCore::register_module canonicalizes the name to lowercase
        // for storage and the action->module map.
        self.core.register_module(name, instance);

        Ok(())
    }

    /// Get the current revision number.
    #[wasm_bindgen(js_name = getRevision)]
    pub fn get_revision(&self) -> u64 {
        self.core.revision
    }

    /// Return a JSON snapshot of the active module's current state.
    #[wasm_bindgen(js_name = currentState)]
    pub fn current_state(&self) -> JsValue {
        let state = self
            .core.module
            .as_ref()
            .map(|m| m.get_state())
            .unwrap_or(&NULL_STATE);
        let serializer = serde_wasm_bindgen::Serializer::json_compatible();
        serde::Serialize::serialize(state, &serializer).unwrap_or(JsValue::NULL)
    }

    /// Return the total number of nodes currently in the instance tree.
    #[wasm_bindgen(js_name = treeSize)]
    pub fn tree_size(&self) -> usize {
        self.core.tree.len()
    }

    /// Validate that the engine is in a consistent state.
    #[wasm_bindgen(js_name = validate)]
    pub fn validate(&self) -> JsValue {
        if let Some(root_id) = self.core.tree.root() {
            if self.core.tree.get(root_id).is_none() {
                return JsValue::from_str("Root node ID references a non-existent node");
            }
        }

        for (node_id, node) in self.core.tree.iter() {
            for child_id in &node.children {
                match self.core.tree.get(*child_id) {
                    None => {
                        return JsValue::from_str(&format!(
                            "Node {} references non-existent child {}",
                            crate::reconcile::node_id_str(node_id),
                            crate::reconcile::node_id_str(*child_id),
                        ));
                    }
                    Some(child) => {
                        if child.parent != Some(node_id) {
                            return JsValue::from_str(&format!(
                                "Child {} parent back-reference does not point to {}",
                                crate::reconcile::node_id_str(*child_id),
                                crate::reconcile::node_id_str(node_id),
                            ));
                        }
                    }
                }
            }
        }

        JsValue::NULL
    }

    /// Fully reset the engine to its initial empty state.
    #[wasm_bindgen(js_name = reset)]
    pub fn reset(&mut self) {
        self.core = EngineCore::new();
        self.action_handlers.clear();
        self.import_visited.clear();
        self.node_id_index = NodeIdIndex::new();
    }
}

/// Serialize a patches array to a pretty-printed JSON string.
#[wasm_bindgen(js_name = patchesToJson)]
pub fn patches_to_json(patches: JsValue) -> Result<String, JsValue> {
    let patches: Vec<Patch> = from_value(patches)
        .map_err(|e| structured_error("stateError", &format!("Invalid patches: {}", e)))?;

    serde_json::to_string_pretty(&patches)
        .map_err(|e| structured_error("renderError", &format!("Serialization error: {}", e)))
}

/// Parse Hypen DSL source and return the AST as a pretty-printed JSON string.
#[wasm_bindgen(js_name = parseToJson)]
pub fn parse_to_json(source: &str) -> Result<String, JsValue> {
    let component = hypen_parser::parse_component(source)
        .map_err(|e| structured_error("parseError", &format_parse_errors(&e)))?;

    serde_json::to_string_pretty(&component)
        .map_err(|e| structured_error("renderError", &format!("Serialization error: {}", e)))
}

#[wasm_bindgen(start)]
pub fn main() {}

// ── Portable helpers (see engine::portable) ──────────────────────────────
//
// wasm-bindgen surface for the engine's portable helpers. JSON is used
// as the transport on purpose: it sidesteps JS-native value coercion
// quirks (e.g. `Number` vs `BigInt`) and lets callers deserialise into
// whatever shape suits them.

/// JSON-in, JSON-out: returns `[{"path": "...", "value": <any>}, ...]`.
///
/// See [`crate::portable::diff_paths`] for semantics.
#[wasm_bindgen(js_name = diffPaths)]
pub fn diff_paths_js(old_json: &str, new_json: &str) -> Result<String, JsValue> {
    let old: serde_json::Value = serde_json::from_str(old_json)
        .map_err(|e| structured_error("stateError", &format!("diffPaths: bad old JSON: {e}")))?;
    let new: serde_json::Value = serde_json::from_str(new_json)
        .map_err(|e| structured_error("stateError", &format!("diffPaths: bad new JSON: {e}")))?;

    let entries: Vec<serde_json::Value> = crate::portable::diff_paths(&old, &new)
        .into_iter()
        .map(|e| serde_json::json!({ "path": e.path, "value": e.new_value }))
        .collect();

    serde_json::to_string(&entries)
        .map_err(|e| structured_error("stateError", &format!("diffPaths: serialise: {e}")))
}

/// Match a URL pattern against a path. Returns JSON
/// `{"matched": bool, "params": {"id": "42"}}`.
///
/// See [`crate::portable::match_path`] for semantics.
#[wasm_bindgen(js_name = matchPath)]
pub fn match_path_js(pattern: &str, path: &str) -> String {
    match crate::portable::match_path(pattern, path) {
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

/// Read the JSON value at a dotted path. Returns `"null"` if the
/// path doesn't resolve.
#[wasm_bindgen(js_name = pathGet)]
pub fn path_get_js(value_json: &str, path: &str) -> Result<String, JsValue> {
    let v: serde_json::Value = serde_json::from_str(value_json)
        .map_err(|e| structured_error("stateError", &format!("pathGet: bad JSON: {e}")))?;
    let out = crate::portable::path_get(&v, path).unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&out)
        .map_err(|e| structured_error("stateError", &format!("pathGet: serialise: {e}")))
}

/// Test whether `path` resolves inside `value_json`. Returns a JSON
/// boolean (`"true"` / `"false"`).
#[wasm_bindgen(js_name = pathHas)]
pub fn path_has_js(value_json: &str, path: &str) -> Result<String, JsValue> {
    let v: serde_json::Value = serde_json::from_str(value_json)
        .map_err(|e| structured_error("stateError", &format!("pathHas: bad JSON: {e}")))?;
    Ok(if crate::portable::path_has(&v, path) {
        "true"
    } else {
        "false"
    }
    .to_string())
}

/// Set `new_value_json` at `path` inside `value_json`; returns the
/// updated JSON string.
#[wasm_bindgen(js_name = pathSet)]
pub fn path_set_js(
    value_json: &str,
    path: &str,
    new_value_json: &str,
) -> Result<String, JsValue> {
    let mut v: serde_json::Value = serde_json::from_str(value_json)
        .map_err(|e| structured_error("stateError", &format!("pathSet: bad value JSON: {e}")))?;
    let nv: serde_json::Value = serde_json::from_str(new_value_json).map_err(|e| {
        structured_error("stateError", &format!("pathSet: bad new-value JSON: {e}"))
    })?;
    crate::portable::path_set(&mut v, path, nv);
    serde_json::to_string(&v)
        .map_err(|e| structured_error("stateError", &format!("pathSet: serialise: {e}")))
}

/// Delete whatever lives at `path`; returns JSON
/// `{"json": <updated>, "removed": bool}`.
#[wasm_bindgen(js_name = pathDelete)]
pub fn path_delete_js(value_json: &str, path: &str) -> Result<String, JsValue> {
    let mut v: serde_json::Value = serde_json::from_str(value_json)
        .map_err(|e| structured_error("stateError", &format!("pathDelete: bad JSON: {e}")))?;
    let removed = crate::portable::path_delete(&mut v, path);
    serde_json::to_string(&serde_json::json!({ "json": v, "removed": removed }))
        .map_err(|e| structured_error("stateError", &format!("pathDelete: serialise: {e}")))
}

/// Percent-encode a string for URL query components.
#[wasm_bindgen(js_name = encodeUriComponent)]
pub fn encode_uri_component_js(input: &str) -> String {
    crate::portable::encode_uri_component(input)
}

/// Decode a percent-encoded string (`+` → space).
#[wasm_bindgen(js_name = decodeUriComponent)]
pub fn decode_uri_component_js(input: &str) -> String {
    crate::portable::decode_uri_component(input)
}

/// Split `/path?k=v` into `{"path": "...", "query": {...}}`.
#[wasm_bindgen(js_name = parseQuery)]
pub fn parse_query_js(full_path: &str) -> String {
    let (path, query) = crate::portable::parse_query(full_path);
    serde_json::json!({ "path": path, "query": query }).to_string()
}

/// Build a URL from path + JSON object of query params.
#[wasm_bindgen(js_name = buildUrl)]
pub fn build_url_js(path: &str, query_json: &str) -> Result<String, JsValue> {
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(query_json)
        .map_err(|e| structured_error("stateError", &format!("buildUrl: bad query JSON: {e}")))?;
    Ok(crate::portable::build_url(path, &map))
}

/// Advance the session state machine by one event.
///
/// `state_json` and `event_json` must deserialise to
/// [`crate::portable::SessionState`] / [`crate::portable::SessionEvent`].
/// Returns the serialised [`crate::portable::SessionEffect`].
#[wasm_bindgen(js_name = sessionStep)]
pub fn session_step_js(state_json: &str, event_json: &str) -> Result<String, JsValue> {
    let state: crate::portable::SessionState = serde_json::from_str(state_json).map_err(|e| {
        structured_error("stateError", &format!("sessionStep: bad state JSON: {e}"))
    })?;
    let event: crate::portable::SessionEvent = serde_json::from_str(event_json).map_err(|e| {
        structured_error("stateError", &format!("sessionStep: bad event JSON: {e}"))
    })?;

    let effect = crate::portable::session_step(&state, &event);
    serde_json::to_string(&effect)
        .map_err(|e| structured_error("stateError", &format!("sessionStep: serialise: {e}")))
}
