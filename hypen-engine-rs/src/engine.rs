use crate::{
    dispatch::{Action, ActionDispatcher},
    engine_core::EngineCore,
    error::EngineError,
    ir::{ComponentRegistry, IRNode, ResourceRegistry},
    lifecycle::{ModuleInstance, ResourceCache},
    reconcile::Patch,
    state::StateChange,
};
use indexmap::IndexMap;
use std::sync::{Arc, Weak};

/// Callback type for rendering patches to the platform
pub type RenderCallback = Box<dyn Fn(&[Patch]) + Send + Sync>;

/// The main Hypen engine that orchestrates reactive UI rendering.
///
/// # Architecture: Shared Engine, Namespaced State
///
/// Multi-module applications share a **single `Engine` instance**. Each module
/// registers its state under a lowercase-name prefix (e.g., `search`) so the
/// engine holds one merged state tree. The SDK layer (`HypenModuleInstance` in
/// TypeScript, `ModuleInstance` in Kotlin/Swift/Go) manages module lifecycles,
/// action routing, and cross-module communication -- the engine itself only sees
/// a flat JSON state and resolves `@{state.xxx}` bindings against it.
///
/// ## Multi-module Applications
///
/// 1. **One shared engine** -- all modules register their namespaced state into
///    it. Nested modules are expected and use the same engine while keeping
///    their own namespaced state.
///
/// 2. **SDK-managed module instances** -- each SDK maintains multiple module
///    instances (e.g., `HypenModuleInstance` in TypeScript), each with its own
///    state tracking (Proxy in TS, ObservableState in Kotlin/Swift/Go).
///
/// 3. **Cross-module communication** uses `HypenGlobalContext`:
///    ```typescript
///    // In Search's action handler:
///    const app = context.getModule<AppState>("App");
///    const currentView = app.getState().currentView;
///    app.setState({ showSearch: true });
///    ```
///
/// 4. **State binding scope**: Each module's template binds to its own state
///    via the namespace prefix. Cross-module data flows through the global
///    context, keeping each module's reactive graph self-contained.
///
/// ## Design Rationale
///
/// Keeping one shared engine avoids duplicating the parser, reconciler, and
/// dependency graph per module. Namespaced state keys ensure modules don't
/// shadow each other's fields while the engine's path-based dependency tracker
/// naturally scopes re-renders to only the affected module's bindings.
pub struct Engine {
    /// Shared core: component registry, resource registry, module state,
    /// instance tree, dependency graph, scheduler, data sources, etc.
    core: EngineCore,

    /// Action dispatcher
    actions: ActionDispatcher,

    /// Resource cache
    resources: ResourceCache,

    /// Callback to send patches to the platform renderer
    render_callback: Option<RenderCallback>,

    /// Weak handle to the primary module's state Arc as of the last
    /// `notify_state_change` render. Used to detect duplicate notifications
    /// (e.g., an SDK Proxy microtask firing after `update_state` already
    /// processed the same change).
    ///
    /// A `Weak` is used (rather than a raw `usize` pointer) to avoid the
    /// ABA problem: when the original Arc is dropped and a new Arc happens
    /// to be allocated at the same address, pointer-identity comparison
    /// would silently treat them as equal. `Weak` keeps the ArcInner
    /// header alive so `Arc::ptr_eq` on an upgraded `Weak` is unambiguous:
    /// a true result means literally the same allocation.
    last_state_weak: Weak<serde_json::Value>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            core: EngineCore::new(),
            actions: ActionDispatcher::new(),
            resources: ResourceCache::new(),
            render_callback: None,
            last_state_weak: Weak::new(),
        }
    }

    /// Register a custom component
    pub fn register_component(&mut self, component: crate::ir::Component) {
        self.core.register_component(component);
    }

    /// Set the component resolver for dynamic component loading
    /// The resolver receives (component_name, context_path) and should return
    /// ResolvedComponent { source, path } or None
    pub fn set_component_resolver<F>(&mut self, resolver: F)
    where
        F: Fn(&str, Option<&str>) -> Option<crate::ir::ResolvedComponent> + Send + Sync + 'static,
    {
        self.core.set_component_resolver(resolver);
    }

    /// Register a single resource from raw SVG content.
    pub fn register_resource(&mut self, name: &str, svg: &str) {
        self.core.register_resource(name, svg);
    }

    /// Register multiple resources from a name -> SVG map.
    pub fn register_resources(&mut self, map: IndexMap<String, String>) {
        self.core.register_resources(map);
    }

    /// Get access to the resource registry
    pub fn resource_registry(&self) -> &ResourceRegistry {
        &self.core.resource_registry
    }

    /// Get mutable access to the resource registry
    pub fn resource_registry_mut(&mut self) -> &mut ResourceRegistry {
        &mut self.core.resource_registry
    }

    /// Backwards-compatible alias
    pub fn icon_registry(&self) -> &ResourceRegistry {
        &self.core.resource_registry
    }

    /// Backwards-compatible alias
    pub fn icon_registry_mut(&mut self) -> &mut ResourceRegistry {
        &mut self.core.resource_registry
    }

    /// Set the primary module instance (backward-compatible single-module API).
    pub fn set_module(&mut self, module: ModuleInstance) {
        self.core.set_module(module);
    }

    /// Register a named module for multi-module apps.
    ///
    /// The engine scopes `@{state.xxx}` bindings to this module's state when
    /// rendering a component whose source starts with `module <name> { ... }`.
    /// The `name` should be lowercase (e.g., `"search"`).
    ///
    /// Also registers the module's declared actions in the action->module map
    /// so that `update_state` after `dispatch_action` automatically routes
    /// to the correct module.
    pub fn register_module(&mut self, name: impl Into<String>, module: ModuleInstance) {
        self.core.register_module(name, module);
    }

    /// Get a named module's state (for reconciler lookups).
    pub fn get_module_state(&self, name: &str) -> Option<&serde_json::Value> {
        self.core.get_module_state(name)
    }

    /// Get access to all registered modules (for reconciler).
    pub fn modules(&self) -> &IndexMap<String, ModuleInstance> {
        &self.core.modules
    }

    /// Set the render callback
    pub fn set_render_callback<F>(&mut self, callback: F)
    where
        F: Fn(&[Patch]) + Send + Sync + 'static,
    {
        self.render_callback = Some(Box::new(callback));
    }

    /// Register an action handler
    pub fn on_action<F>(&mut self, action_name: impl Into<String>, handler: F)
    where
        F: Fn(&Action) + Send + Sync + 'static,
    {
        self.actions.on(action_name, handler);
    }

    /// Render an element tree (initial render or full re-render).
    ///
    /// This accepts a flat `Element`. For sources that use ForEach, When,
    /// or If, prefer [`render_ir_node`] which preserves first-class control flow.
    pub fn render(&mut self, element: &crate::ir::Element) {
        let ir_node = IRNode::Element(element.clone());
        self.render_ir_node(&ir_node);
    }

    /// Render an IRNode tree (initial render or full re-render).
    ///
    /// Unlike [`render`], this accepts an `IRNode` (from `ast_to_ir_node()`),
    /// which preserves ForEach, When, and If as first-class control-flow nodes.
    /// This is the same path used by the WASM engine.
    pub fn render_ir_node(&mut self, ir_node: &IRNode) {
        let patches = self.core.render_ir_node(ir_node);
        self.emit_patches(patches);
    }

    /// Handle a state change notification from a host that keeps its own state.
    ///
    /// Use this when the host already mutated its own state copy and just
    /// wants the engine to invalidate and re-render the affected nodes.
    /// Engine-owned state should go through [`update_state`] / [`update_state_sparse`]
    /// instead.
    ///
    /// Uses an Arc-identity guard: if the primary module's state Arc is
    /// literally the same allocation as at the last notify_state_change
    /// render, the call is a no-op. This catches SDK Proxy microtasks
    /// re-firing after an explicit `update_state` already processed the
    /// same change.
    ///
    /// The guard uses `Weak::upgrade` + `Arc::ptr_eq` rather than raw
    /// pointer equality so a dropped-and-reallocated Arc at the same
    /// address can never be mistaken for the one we saw before.
    pub fn notify_state_change(&mut self, change: &StateChange) {
        if let Some(ref module) = self.core.module {
            let current = module.get_state_shared();
            if self.core.revision > 0 {
                if let Some(prev) = self.last_state_weak.upgrade() {
                    if Arc::ptr_eq(&prev, &current) {
                        return;
                    }
                }
            }
            self.last_state_weak = Arc::downgrade(&current);
        }

        self.core.schedule_from_state_change(change);
        self.render_dirty();
    }

    /// Apply a state patch and re-render affected nodes.
    ///
    /// `scope` selects the target module:
    /// - `None` → primary module set via [`set_module`](Self::set_module)
    /// - `Some(name)` → named module registered via [`register_module`]
    ///
    /// Skips rendering if the patch produces no actual state change.
    pub fn update_state(&mut self, scope: Option<&str>, state_patch: serde_json::Value) {
        self.update_state_with_animation(scope, state_patch, None)
    }

    /// [`update_state`](Self::update_state) with an optional batch-animation
    /// context (Option D cheap subset — transaction-scoped animation).
    ///
    /// `animation` is either a spec object (`{"curve": "spring", ...}`) or a
    /// bare curve string (`"spring"`, normalized to
    /// `{"curve": "spring", "duration": 250}`). If the update changed state
    /// and the resulting render cycle produced patches, the batch is
    /// prefixed with a [`Patch::BatchAnimation`](crate::reconcile::Patch)
    /// prelude carrying the normalized spec. A no-op update, an empty diff,
    /// or an invalid spec (warned, never a hard error) all emit an
    /// unstamped batch — no stamp without patches.
    pub fn update_state_with_animation(
        &mut self,
        scope: Option<&str>,
        state_patch: serde_json::Value,
        animation: Option<serde_json::Value>,
    ) {
        if self.core.update_state(scope, state_patch, animation) {
            self.render_dirty();
        }
    }

    /// Apply a sparse state patch (path-value pairs) and re-render affected nodes.
    /// See [`update_state`] for `scope` semantics.
    pub fn update_state_sparse(
        &mut self,
        scope: Option<&str>,
        paths: &[String],
        values: &serde_json::Value,
    ) {
        self.update_state_sparse_with_animation(scope, paths, values, None)
    }

    /// [`update_state_sparse`](Self::update_state_sparse) with an optional
    /// batch-animation context. See
    /// [`update_state_with_animation`](Self::update_state_with_animation)
    /// for the stamping contract.
    pub fn update_state_sparse_with_animation(
        &mut self,
        scope: Option<&str>,
        paths: &[String],
        values: &serde_json::Value,
        animation: Option<serde_json::Value>,
    ) {
        if self.core.update_state_sparse(scope, paths, values, animation) {
            self.render_dirty();
        }
    }

    /// Dispatch an action to its registered handler.
    pub fn dispatch_action(&mut self, action: Action) -> Result<(), EngineError> {
        self.actions.dispatch(&action)
    }

    /// Look up which named module (by lowercased name) owns a given action.
    ///
    /// Returns `Some(name)` when the action was registered via
    /// [`register_module`]. Returns `None` for both "primary-module actions"
    /// (declared on the module set via [`set_module`]) and "unknown actions"
    /// — in both cases callers should route follow-up `update_state` calls
    /// to the primary slot (scope `None`), which is the correct default.
    ///
    /// Callers that host action handlers outside the engine (e.g., the Rust
    /// SDK's `RemoteSession`) can use this to route an incoming dispatch to
    /// the correct module's state without having to call
    /// [`dispatch_action`](Self::dispatch_action).
    pub fn action_scope_for(&self, action_name: &str) -> Option<String> {
        self.core.action_scope_for(action_name)
    }

    /// Render only dirty nodes
    fn render_dirty(&mut self) {
        let patches = self.core.render_dirty();
        if !patches.is_empty() {
            self.emit_patches(patches);
        }
    }

    /// Send patches to the renderer.
    /// Filters out Remove patches for elements that were Created in the same
    /// batch -- this happens when a conditional re-reconciles module-scoped
    /// children whose stored template doesn't carry module_scope.
    fn emit_patches(&self, mut patches: Vec<Patch>) {
        EngineCore::filter_spurious_removes(&mut patches);
        if let Some(ref callback) = self.render_callback {
            callback(&patches);
        }
    }

    /// Get the current revision number
    pub fn revision(&self) -> u64 {
        self.core.revision
    }

    /// Get access to the component registry
    pub fn component_registry(&self) -> &ComponentRegistry {
        &self.core.component_registry
    }

    /// Get mutable access to the component registry
    pub fn component_registry_mut(&mut self) -> &mut ComponentRegistry {
        &mut self.core.component_registry
    }

    /// Get access to the resource cache
    pub fn resources(&self) -> &ResourceCache {
        &self.resources
    }

    /// Get mutable access to the resource cache
    pub fn resources_mut(&mut self) -> &mut ResourceCache {
        &mut self.resources
    }

    // ── Data Source Context ─────────────────────────────────────────────

    /// Set (or replace) a named data source context.
    ///
    /// Registers the provider in the dependency graph (if not already known),
    /// stores the data, and re-renders every node bound to `@name.*`.
    /// This is the single entry point for all data source writes --
    /// sparse merging (if needed) should happen at the SDK layer before
    /// calling this method with the merged object.
    ///
    /// # Example
    /// ```ignore
    /// engine.set_context("spacetime", json!({
    ///     "message": [{ "id": 1, "text": "Hello" }],
    ///     "user": [{ "id": 1, "name": "Alice" }]
    /// }));
    /// ```
    pub fn set_context(&mut self, name: &str, data: serde_json::Value) {
        self.core.set_context(name, data);
        self.render_dirty();
    }

    /// Remove a data source context entirely.
    ///
    /// Drops the provider's state and re-renders bound nodes (they resolve to null).
    pub fn remove_context(&mut self, name: &str) {
        self.core.remove_context(name);
        self.render_dirty();
    }

    /// Get read access to the data sources map.
    pub fn data_sources(&self) -> &indexmap::IndexMap<String, serde_json::Value> {
        &self.core.data_sources
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
