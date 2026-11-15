use crate::{
    action_routing::{scoped_action_name, split_scoped_action, UI_ACTION},
    dispatch::{Action, ActionDispatcher},
    engine_core::EngineCore,
    error::EngineError,
    ir::{ComponentRegistry, IRNode, NodeId, ResourceRegistry},
    lifecycle::{ModuleInstance, ResourceCache},
    module_host::{
        Effect, HostAction, LogLevel, ModuleHost, ModuleInstanceId, ReducerOutput, SiblingState,
        SubscribeRequest,
    },
    reconcile::Patch,
    state::StateChange,
};
use indexmap::IndexMap;
use std::sync::{Arc, Weak};

/// Callback type for rendering patches to the platform
pub type RenderCallback = Box<dyn Fn(&[Patch]) + Send + Sync>;

/// Handler for engine-native effects (`Navigate` / `Delay`) the host performs.
/// Receives the originating module scope and the effect.
pub type EffectHandler = Box<dyn Fn(&str, &Effect) + Send + Sync>;

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
    ///
    /// `pub(crate)` so the external-surface module (`crate::agent`) can read
    /// the registries it guards against. Still private to the crate.
    pub(crate) core: EngineCore,

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

    /// Optional WASM module host. When installed, actions registered via
    /// [`register_module_instance`](Self::register_module_instance) are
    /// routed to a module's `dispatch` export instead of a closure handler.
    module_host: Option<Box<dyn ModuleHost>>,

    /// Maps `(scope, action name)` → instance for module-backed actions.
    ///
    /// Keying by scope (not by bare action name) lets several modules export
    /// the *same* action name without colliding — e.g. two `Counter()`s each
    /// with `increment`. `dispatch_action` resolves the owning scope (from a
    /// `scope:action` qualifier, the dispatching node, or — when unambiguous —
    /// the bare name) before looking up the instance here.
    module_actions: IndexMap<(String, String), ModuleInstanceId>,

    /// Optional host hook for engine-native effects the engine can't perform
    /// on its own — `Navigate` (needs the host's router) and `Delay` (needs a
    /// timer). Called from [`perform_effect`](Self::perform_effect) with the
    /// originating module scope. `Log` stays engine-native and does not go
    /// through this hook. When unset, `Navigate`/`Delay` are logged only.
    on_effect: Option<EffectHandler>,

    /// Active cross-module subscriptions (via `hypen:engine/state.subscribe`).
    /// Fired when a target's state changes at the watched path; cleared for a
    /// scope when it is re-registered or re-wired (reload / teardown).
    subscriptions: Vec<Subscription>,

    /// Current depth of the module-dispatch cascade (top-level dispatch = 1).
    /// Guards `emit` / cross-dispatch / subscription re-entry against runaway
    /// cycles; see [`MAX_DISPATCH_DEPTH`].
    dispatch_depth: u32,
}

/// A registered cross-module subscription: `subscriber` gets `on_change`
/// dispatched to it whenever `target`'s state changes at (or under, or at an
/// ancestor of) `path`.
struct Subscription {
    subscriber: String,
    target: String,
    path: String,
    on_change: String,
}

/// Hard cap on how deep a single top-level dispatch may cascade through
/// `emit` / cross-module dispatch / subscription notifications. Bounds
/// pathological cycles (e.g. two modules that subscribe to each other and each
/// flip a value) so they can't hang or overflow the host.
const MAX_DISPATCH_DEPTH: u32 = 32;

/// Outcome of resolving a dispatched [`Action`] to a module instance.
enum ModuleRouting {
    /// The action belongs to the module instance wired under this scope.
    Module(String, ModuleInstanceId),
    /// A bare action name is exported by more than one module scope; the
    /// caller must qualify it (`scope:action`) or dispatch from a scoped node.
    Ambiguous(Vec<String>),
    /// Not a module-backed action — fall through to the closure dispatcher.
    NotModule,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            core: EngineCore::new(),
            actions: ActionDispatcher::new(),
            resources: ResourceCache::new(),
            render_callback: None,
            last_state_weak: Weak::new(),
            module_host: None,
            module_actions: IndexMap::new(),
            on_effect: None,
            subscriptions: Vec::new(),
            dispatch_depth: 0,
        }
    }

    /// Install a handler for engine-native effects (`Navigate`, `Delay`) that
    /// the engine surfaces but can't perform itself — the host provides the
    /// router / timer. See [`Effect`](crate::module_host::Effect). `Log` is
    /// handled engine-side and never reaches this handler.
    pub fn set_effect_handler<F>(&mut self, handler: F)
    where
        F: Fn(&str, &Effect) + Send + Sync + 'static,
    {
        self.on_effect = Some(Box::new(handler));
    }

    /// Clear the component registry's resolved-component caches so referenced
    /// components re-resolve from fresh source on the next render. The hook a
    /// host uses to hot-reload `.hypen` templates.
    pub fn clear_resolved_components(&mut self) {
        self.core.component_registry.clear_resolved();
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

    /// Set the render callback.
    ///
    /// The callback receives the engine's raw patch stream, which carries
    /// template-shaped list rows as `RegisterTemplate`/`Instantiate`.
    /// Embedders whose consumers need the plain `Create`+`Insert` wire
    /// lower each batch through one session-lifetime
    /// [`crate::portable::TemplateExpander`].
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
        let name = action_name.into();
        self.core.note_handler(&name);
        self.actions.on(name, handler);
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
        if self
            .core
            .update_state_sparse(scope, paths, values, animation)
        {
            self.render_dirty();
        }
    }

    /// Install a WASM module host. Once installed, modules registered via
    /// [`register_module_instance`](Self::register_module_instance) handle
    /// their actions in WASM rather than via host closures.
    pub fn set_module_host(&mut self, host: Box<dyn ModuleHost>) {
        self.module_host = Some(host);
    }

    /// Mutable access to the installed module host (for registering and
    /// instantiating module components before wiring their instances).
    pub fn module_host_mut(&mut self) -> Option<&mut (dyn ModuleHost + 'static)> {
        self.module_host.as_deref_mut()
    }

    /// Wire an already-instantiated WASM module instance into the engine.
    ///
    /// Seeds the module's state slot under `scope` with `initial_state` (as
    /// returned by the host's `init`) and routes each name in `actions` to
    /// this instance. After this, dispatching one of those actions drives the
    /// module's `dispatch` export and re-renders the affected bindings.
    pub fn register_module_instance(
        &mut self,
        scope: &str,
        id: ModuleInstanceId,
        actions: Vec<String>,
        initial_state: serde_json::Value,
    ) {
        let scope = scope.to_lowercase();
        // Idempotent: drop any previous action routing for this scope before
        // re-wiring. Lets hot-reload call this again without leaking stale
        // entries. Also drop this scope's own subscriptions — a fresh instance
        // re-subscribes on demand, and stale ones must not fire.
        self.unwire_module_actions(&scope);
        self.subscriptions.retain(|sub| sub.subscriber != scope);
        let module = crate::lifecycle::Module::new(&scope).with_actions(actions.clone());
        let instance = ModuleInstance::new(module, initial_state);
        self.core.register_module(&scope, instance);
        self.wire_module_actions(scope, id, actions);
    }

    /// Re-wire an existing module scope to a new instance, **preserving the
    /// scope's current state**. Used by hot reload after the caller has
    /// destroyed the old instance and instantiated a new one via the
    /// `ModuleHost`. State stays in `EngineCore::modules` untouched; only
    /// the action→instance routing is updated.
    pub fn rewire_module_instance(
        &mut self,
        scope: &str,
        new_id: ModuleInstanceId,
        actions: Vec<String>,
    ) {
        let scope = scope.to_lowercase();
        self.unwire_module_actions(&scope);
        // The reloaded instance re-subscribes on demand; drop the old ones.
        self.subscriptions.retain(|sub| sub.subscriber != scope);
        self.wire_module_actions(scope, new_id, actions);
    }

    /// Route `actions` of `scope` to instance `id`, and record each one as a
    /// scoped handler in the core so a renderer's `__hypen_dispatch` envelope
    /// for a node this module owns resolves (see
    /// [`EngineCore::route_ui_action`]) instead of failing closed.
    fn wire_module_actions(&mut self, scope: String, id: ModuleInstanceId, actions: Vec<String>) {
        for action in actions {
            self.core.note_handler(&scoped_action_name(&scope, &action));
            self.module_actions.insert((scope.clone(), action), id);
        }
    }

    /// Drop every action routed to `scope`, including the scoped-handler
    /// records [`wire_module_actions`](Self::wire_module_actions) added
    /// (unless a closure handler was registered under the same scoped name).
    fn unwire_module_actions(&mut self, scope: &str) {
        let actions = &self.actions;
        let registered = &mut self.core.registered_actions;
        self.module_actions.retain(|(s, action), _| {
            if s != scope {
                return true;
            }
            let scoped = scoped_action_name(s, action);
            if !actions.has_handler(&scoped) {
                registered.retain(|a| a != &scoped);
            }
            false
        });
    }

    /// Return the current instance id wired to a scope, if any. The result
    /// reflects the most recent `register_module_instance` /
    /// `rewire_module_instance` call.
    pub fn module_instance_id(&self, scope: &str) -> Option<ModuleInstanceId> {
        let scope = scope.to_lowercase();
        self.module_actions
            .iter()
            .find(|((s, _), _)| s == &scope)
            .map(|(_, id)| *id)
    }

    /// Drive a module's `on_activated` lifecycle export for `scope` and fold
    /// the resulting [`ReducerOutput`] back into the engine — exactly as a
    /// `dispatch` output is folded (state delta -> reactive render, effects,
    /// emitted actions, cross-dispatch, and **subscriptions**). This is what
    /// lets a module wire a cross-module `subscribe` (or seed effects /
    /// follow-up actions) the moment it becomes active, instead of only from an
    /// explicit UI action.
    ///
    /// No-ops when `scope` has no wired instance. The fold runs under the
    /// dispatch-depth guard, so a lifecycle hook that emits or cross-dispatches
    /// can't spin an unbounded re-entry cycle.
    pub fn activate_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let scope = scope.to_lowercase();
        let Some(id) = self.module_instance_id(&scope) else {
            return Ok(());
        };
        let old_state = self
            .core
            .get_module_state(&scope)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let old_bytes =
            serde_json::to_vec(&old_state).map_err(|e| EngineError::StateError(e.to_string()))?;
        let siblings = self.siblings_for(&scope);

        let output = {
            let host = self
                .module_host
                .as_mut()
                .ok_or_else(|| EngineError::ModuleError("no module host installed".into()))?;
            host.on_activated(id, &old_bytes, &siblings)
                .map_err(|e| EngineError::ModuleError(e.to_string()))?
        };

        self.fold_lifecycle_output(&scope, &old_state, output)
    }

    /// Drive a module's `on_destroyed` lifecycle export for `scope`, giving it
    /// a chance to run teardown before its instance is dropped. `on_destroyed`
    /// returns no [`ReducerOutput`] (the instance is going away), so there is
    /// nothing to fold. No-ops when `scope` has no wired instance.
    pub fn destroy_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let scope = scope.to_lowercase();
        let Some(id) = self.module_instance_id(&scope) else {
            return Ok(());
        };
        let old_state = self
            .core
            .get_module_state(&scope)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let old_bytes =
            serde_json::to_vec(&old_state).map_err(|e| EngineError::StateError(e.to_string()))?;
        let host = self
            .module_host
            .as_mut()
            .ok_or_else(|| EngineError::ModuleError("no module host installed".into()))?;
        host.on_destroyed(id, &old_bytes)
            .map_err(|e| EngineError::ModuleError(e.to_string()))
    }

    /// Dispatch an action to its registered handler.
    ///
    /// Module-backed actions (registered via
    /// [`register_module_instance`](Self::register_module_instance)) are
    /// routed to the owning WASM module; everything else falls through to the
    /// closure-based [`ActionDispatcher`].
    ///
    /// # Scope resolution
    ///
    /// When several modules export the same action name, the engine resolves
    /// which one to drive, in priority order:
    /// 1. **Explicit qualifier** — `action.name == "scope:action"` routes to
    ///    `scope` (used by the REPL / HTTP API).
    /// 2. **Dispatching node** — `action.sender` holds the patch-wire node id
    ///    of the element that fired the action; the engine maps it back to that
    ///    node's `module_scope` (used by renderers).
    /// 3. **Unambiguous bare name** — if exactly one scope exports the name,
    ///    route to it. If more than one does, the dispatch errors and asks the
    ///    caller to qualify the action.
    ///
    /// # UI envelopes with a module host
    ///
    /// The current renderer protocol (`__hypen_dispatch` envelopes and the
    /// `__hypen_scoped:<scope>:<name>` names they resolve to) is always
    /// resolved by [`EngineCore::route_ui_action`] first — node ownership is
    /// the only routing authority there. If the resolved scoped name belongs
    /// to a wired module instance it drives that module; otherwise it goes to
    /// the closure dispatcher exactly as without a module host.
    ///
    /// With no module instance wired, this is exactly
    /// `route_ui_action` + closure dispatch.
    pub fn dispatch_action(&mut self, action: Action) -> Result<(), EngineError> {
        // Fast path / pre-module-host behaviour: nothing is module-backed.
        if self.module_actions.is_empty() {
            let action = self.core.route_ui_action(action)?;
            return self.actions.dispatch(&action);
        }

        // Renderer protocol: resolve ownership in the core, then hand the
        // result to the owning module instance when there is one.
        if action.name == UI_ACTION || split_scoped_action(&action.name).is_some() {
            let mut action = self.core.route_ui_action(action)?;
            let hit = split_scoped_action(&action.name).and_then(|(scope, name)| {
                let key = (scope.to_string(), name.to_string());
                self.module_actions.get(&key).map(|id| (key, *id))
            });
            return match hit {
                Some(((scope, name), id)) => {
                    action.name = name;
                    self.dispatch_to_module(id, scope, action)
                }
                None => self.actions.dispatch(&action),
            };
        }

        let mut action = action;
        match self.route_module_action(&mut action) {
            ModuleRouting::Module(scope, id) => self.dispatch_to_module(id, scope, action),
            ModuleRouting::Ambiguous(scopes) => Err(EngineError::ModuleError(format!(
                "action '{}' is exported by multiple modules ({}); qualify it as \
                 '<scope>:{}' or dispatch it from a scoped node",
                action.name,
                scopes.join(", "),
                action.name,
            ))),
            ModuleRouting::NotModule => {
                let action = self.core.route_ui_action(action)?;
                self.actions.dispatch(&action)
            }
        }
    }

    /// Resolve a dispatched action to its owning module instance, normalizing
    /// `action.name` to the bare name the module's `dispatch` export expects
    /// (stripping any `scope:` qualifier). See [`dispatch_action`] for the
    /// resolution order.
    ///
    /// [`dispatch_action`]: Self::dispatch_action
    fn route_module_action(&self, action: &mut Action) -> ModuleRouting {
        // 1. Explicit `scope:action` qualifier.
        if let Some((scope, name)) = action.name.split_once(':') {
            let key = (scope.to_lowercase(), name.to_string());
            if let Some(id) = self.module_actions.get(&key) {
                let id = *id;
                action.name = name.to_string();
                return ModuleRouting::Module(key.0, id);
            }
            // A `:`-bearing name that isn't a known qualifier falls through to
            // the closure dispatcher (Hypen action names never contain ':').
            return ModuleRouting::NotModule;
        }

        // 2. Scope inferred from the dispatching node (sender = node id string).
        if let Some(sender) = action.sender.as_deref() {
            if let Some(scope) = self.core.scope_of_node(sender) {
                let key = (scope.clone(), action.name.clone());
                if let Some(id) = self.module_actions.get(&key) {
                    return ModuleRouting::Module(scope, *id);
                }
            }
        }

        // 3. Bare name: unambiguous only when a single scope claims it.
        let mut hit: Option<(String, ModuleInstanceId)> = None;
        let mut scopes: Vec<String> = Vec::new();
        for ((scope, name), id) in &self.module_actions {
            if name == &action.name {
                scopes.push(scope.clone());
                if hit.is_none() {
                    hit = Some((scope.clone(), *id));
                }
            }
        }
        match scopes.len() {
            0 => ModuleRouting::NotModule,
            1 => {
                let (scope, id) = hit.expect("one match implies a hit");
                ModuleRouting::Module(scope, id)
            }
            _ => ModuleRouting::Ambiguous(scopes),
        }
    }

    /// Drive a module's `dispatch` export, then fold its result back into the
    /// engine: state delta → path diff → reactive re-render; effects; emitted
    /// follow-up actions. This is the bridge that keeps a pure-reducer WASM
    /// module reactive without it owning any engine state.
    /// Depth-guarded entry to the module-dispatch cascade. Increments the
    /// cascade depth, refusing to recurse past [`MAX_DISPATCH_DEPTH`] (which
    /// breaks subscription/emit/cross-dispatch cycles), and always restores the
    /// depth afterward.
    fn dispatch_to_module(
        &mut self,
        id: ModuleInstanceId,
        scope: String,
        action: Action,
    ) -> Result<(), EngineError> {
        if self.dispatch_depth >= MAX_DISPATCH_DEPTH {
            crate::logger::log(
                crate::logger::LogLevel::Warn,
                crate::logger::LogScope::Engine,
                &format!(
                    "[{scope}] dispatch cascade exceeded depth {MAX_DISPATCH_DEPTH} \
                     (action '{}'); dropping to break a possible cycle",
                    action.name
                ),
            );
            return Ok(());
        }
        self.dispatch_depth += 1;
        let result = self.dispatch_to_module_inner(id, scope, action);
        self.dispatch_depth -= 1;
        result
    }

    fn dispatch_to_module_inner(
        &mut self,
        id: ModuleInstanceId,
        scope: String,
        action: Action,
    ) -> Result<(), EngineError> {
        // Snapshot current state for this scope (the reducer's input).
        let old_state = self
            .core
            .get_module_state(&scope)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let old_bytes = serde_json::to_vec(&old_state)
            .map_err(|e| EngineError::StateError(e.to_string()))?;
        let payload = action.payload.clone().unwrap_or(serde_json::Value::Null);
        let payload_bytes =
            serde_json::to_vec(&payload).map_err(|e| EngineError::StateError(e.to_string()))?;

        // Gather sibling snapshots this module may read via
        // `hypen:engine/state.read`. The host filters by the manifest ACL; we
        // pass everything except the module's own scope.
        let siblings = self.siblings_for(&scope);

        let output = {
            let host = self
                .module_host
                .as_mut()
                .ok_or_else(|| EngineError::ModuleError("no module host installed".into()))?;
            host.dispatch(
                id,
                &old_bytes,
                HostAction::new(action.name, payload_bytes),
                &siblings,
            )
            .map_err(|e| EngineError::ModuleError(e.to_string()))?
        };

        self.apply_module_output(&scope, &old_state, output)
    }

    /// Fold a [`ReducerOutput`] back into engine state, effects, and the
    /// action queue.
    fn apply_module_output(
        &mut self,
        scope: &str,
        old_state: &serde_json::Value,
        output: ReducerOutput,
    ) -> Result<(), EngineError> {
        // 1. State delta → path-level diff → sparse update → reactive render.
        //    `changed_paths` is kept for subscription notification (step 5).
        let mut changed_paths: Vec<String> = Vec::new();
        if let Some(new_bytes) = output.state {
            let new_state: serde_json::Value = serde_json::from_slice(&new_bytes)
                .map_err(|e| EngineError::StateError(e.to_string()))?;
            let diff = crate::portable::diff_paths(old_state, &new_state);
            if !diff.is_empty() {
                let mut paths = Vec::with_capacity(diff.len());
                let mut values = serde_json::Map::with_capacity(diff.len());
                for entry in diff {
                    values.insert(entry.path.clone(), entry.new_value);
                    paths.push(entry.path);
                }
                let values = serde_json::Value::Object(values);
                if self.core.update_state_sparse(Some(scope), &paths, &values, None) {
                    self.render_dirty();
                }
                changed_paths = paths;
            }
        }

        // 2. Side effects the host performs directly.
        for effect in output.effects {
            self.perform_effect(scope, effect);
        }

        // 3. Emitted follow-up actions, dispatched in order. An emit is the
        //    module's own follow-up, so route it back to *this* scope (it may
        //    share an action name with a sibling module).
        for act in output.emit {
            let payload: serde_json::Value =
                serde_json::from_slice(&act.payload).unwrap_or(serde_json::Value::Null);
            let name = self.qualify_if_module_action(scope, &act.name);
            self.dispatch_action(Action::new(name).with_payload(payload))?;
        }

        // 4. Cross-module dispatches the reducer requested. Routed to the named
        //    target scope so the right module's reducer runs and its own
        //    reactive re-render happens — even when several modules export an
        //    action of the same name.
        for (target, act) in output.cross_dispatch {
            let payload: serde_json::Value =
                serde_json::from_slice(&act.payload).unwrap_or(serde_json::Value::Null);
            let name = self.qualify_if_module_action(&target, &act.name);
            self.dispatch_action(Action::new(name).with_payload(payload))?;
        }

        // 5. Notify subscribers watching THIS scope, for each path that just
        //    changed. Fire before registering this output's own subscriptions
        //    (step 6) so a fresh subscription doesn't self-fire on the change
        //    that created it. Re-dispatch is depth-guarded (cycle-safe).
        if !changed_paths.is_empty() {
            let to_fire: Vec<(String, String)> = self
                .subscriptions
                .iter()
                .filter(|s| s.target == scope)
                .filter(|s| changed_paths.iter().any(|p| paths_overlap(p, &s.path)))
                .map(|s| (s.subscriber.clone(), s.on_change.clone()))
                .collect();
            for (subscriber, on_change) in to_fire {
                let name = self.qualify_if_module_action(&subscriber, &on_change);
                self.dispatch_action(Action::new(name))?;
            }
        }

        // 6. Register the subscriptions this reducer requested. The subscriber
        //    is the module we just ran; the target scope is normalized to match
        //    the engine's lowercased module keys.
        for req in output.subscribe_requests {
            self.add_subscription(scope, req);
        }

        Ok(())
    }

    /// Gather sibling state snapshots for `scope`: every *other* module's
    /// current state, JSON-encoded, for the host to expose via
    /// `hypen:engine/state.read` (the host still enforces the per-target ACL).
    fn siblings_for(&self, scope: &str) -> Vec<SiblingState> {
        self.core
            .modules
            .iter()
            .filter(|(name, _)| name.as_str() != scope)
            .filter_map(|(name, inst)| {
                serde_json::to_vec(inst.get_state())
                    .ok()
                    .map(|bytes| (name.clone(), bytes))
            })
            .collect()
    }

    /// Fold a lifecycle [`ReducerOutput`] (from `on_activated`) through
    /// [`apply_module_output`](Self::apply_module_output) under the same depth
    /// guard that bounds the dispatch cascade — so a lifecycle hook that emits,
    /// cross-dispatches, or triggers a subscription can't spin an unbounded
    /// re-entry cycle. Mirrors [`dispatch_to_module`](Self::dispatch_to_module).
    fn fold_lifecycle_output(
        &mut self,
        scope: &str,
        old_state: &serde_json::Value,
        output: ReducerOutput,
    ) -> Result<(), EngineError> {
        if self.dispatch_depth >= MAX_DISPATCH_DEPTH {
            crate::logger::log(
                crate::logger::LogLevel::Warn,
                crate::logger::LogScope::Engine,
                &format!(
                    "[{scope}] lifecycle fold exceeded depth {MAX_DISPATCH_DEPTH}; \
                     dropping to break a possible cycle"
                ),
            );
            return Ok(());
        }
        self.dispatch_depth += 1;
        let result = self.apply_module_output(scope, old_state, output);
        self.dispatch_depth -= 1;
        result
    }

    /// Register (or replace) a cross-module subscription. Replacing an existing
    /// `(subscriber, target, path)` keeps the set idempotent under repeated
    /// `subscribe` calls.
    fn add_subscription(&mut self, subscriber: &str, req: SubscribeRequest) {
        let sub = Subscription {
            subscriber: subscriber.to_string(),
            target: req.target.to_lowercase(),
            path: req.path,
            on_change: req.on_change,
        };
        self.subscriptions.retain(|s| {
            !(s.subscriber == sub.subscriber && s.target == sub.target && s.path == sub.path)
        });
        self.subscriptions.push(sub);
    }

    /// Prefix an action with `scope:` when that scope exports it, so the
    /// dispatch routes deterministically to that module instance. Falls back to
    /// the bare name otherwise (closure handlers, or actions owned by a single
    /// scope), preserving the existing routing for those cases.
    fn qualify_if_module_action(&self, scope: &str, name: &str) -> String {
        let scope = scope.to_lowercase();
        if self
            .module_actions
            .contains_key(&(scope.clone(), name.to_string()))
        {
            format!("{scope}:{name}")
        } else {
            name.to_string()
        }
    }

    /// Perform an engine-native effect. `Log` is handled here directly. HTTP
    /// is *not* an effect: modules call `wasi:http` directly through their
    /// language's idiomatic client. `Navigate` and `Delay` need host
    /// cooperation (a router / a timer), so they are handed to the installed
    /// [`EffectHandler`](Self::set_effect_handler); with none installed they
    /// are logged only.
    fn perform_effect(&mut self, scope: &str, effect: Effect) {
        match effect {
            Effect::Log { level, message } => {
                use crate::logger::{LogLevel as LL, LogScope};
                let ll = match level {
                    LogLevel::Trace => LL::Trace,
                    LogLevel::Debug => LL::Debug,
                    LogLevel::Info => LL::Info,
                    LogLevel::Warn => LL::Warn,
                    LogLevel::Error => LL::Error,
                };
                crate::logger::log(ll, LogScope::Engine, &format!("[{scope}] {message}"));
            }
            // Navigate + Delay need host cooperation (a router / a timer). Hand
            // them to the installed effect handler; if none, log the intent so
            // it isn't silently swallowed.
            effect @ (Effect::Navigate(_) | Effect::Delay { .. }) => {
                if let Some(handler) = &self.on_effect {
                    handler(scope, &effect);
                } else {
                    match &effect {
                        Effect::Navigate(path) => crate::logger::log(
                            crate::logger::LogLevel::Debug,
                            crate::logger::LogScope::Engine,
                            &format!("[{scope}] navigate -> {path} (no effect handler)"),
                        ),
                        Effect::Delay { then, ms } => crate::logger::log(
                            crate::logger::LogLevel::Warn,
                            crate::logger::LogScope::Engine,
                            &format!("[{scope}] Delay({ms}ms -> {then}) dropped (no effect handler)"),
                        ),
                        Effect::Log { .. } => unreachable!(),
                    }
                }
            }
        }
    }

    /// Resolve a UI envelope for hosts that own their action dispatch loop.
    pub fn resolve_ui_action(&self, action: Action) -> Result<Action, EngineError> {
        self.core.route_ui_action(action)
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

    /// How many control-flow nodes are waiting for their detached route to
    /// be attached again. Test-only introspection: a teardown must never
    /// leave ids behind here.
    #[doc(hidden)]
    pub fn deferred_detached_len(&self) -> usize {
        self.core.tree.deferred_detached.len()
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

    // ── List Virtualization ─────────────────────────────────────────────

    /// Report a lazy list's visible range. `list_id` is the element carrying
    /// `__virt.window`; `[start, end)` is the item range the renderer wants
    /// materialized (visible rows plus overscan). Emits the patches that
    /// move the window. Ids naming no windowed list are ignored.
    pub fn set_list_viewport(&mut self, list_id: NodeId, start: usize, end: usize) {
        let patches = self.core.set_list_viewport(list_id, start, end);
        if !patches.is_empty() {
            self.emit_patches(patches);
        }
    }

    /// [`set_list_viewport`](Self::set_list_viewport) addressed by the id
    /// string the element carries on the wire — what a renderer or a remote
    /// `viewport` message has. A malformed id is ignored.
    pub fn set_list_viewport_wire(&mut self, list_id: &str, start: usize, end: usize) {
        let patches = self.core.set_list_viewport_wire(list_id, start, end);
        if !patches.is_empty() {
            self.emit_patches(patches);
        }
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

/// Whether a changed state path `changed` should trigger a subscription to
/// `watched`: true when they are the same, when one is a descendant of the
/// other (a parent change implies the child changed, and vice-versa), or when
/// either is empty (a whole-state watch / whole-state replacement).
fn paths_overlap(changed: &str, watched: &str) -> bool {
    if changed.is_empty() || watched.is_empty() {
        return true;
    }
    changed == watched
        || changed.starts_with(&format!("{watched}."))
        || watched.starts_with(&format!("{changed}."))
}
