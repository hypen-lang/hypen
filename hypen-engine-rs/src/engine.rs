use crate::{
    dispatch::{Action, ActionDispatcher},
    engine_core::EngineCore,
    error::EngineError,
    hosted::{
        paths::{collect_merge_changes, collect_sparse_changes},
        CascadeReport, EngineCtx, HostedModules, HttpCompletionError, HttpDelivery,
        LifecycleHook, PatchOutlet,
    },
    ir::{ComponentRegistry, IRNode, NodeId, ResourceRegistry},
    lifecycle::{ModuleInstance, ResourceCache},
    module_host::{
        Effect, HttpDenial, HttpOutcome, HttpRequestId, HttpUrl, ModuleHost, ModuleInstanceId,
    },
    reconcile::Patch,
    state::StateChange,
};
use indexmap::IndexMap;
use std::sync::{Arc, Weak};

// The hosted-module subsystem lives in `crate::hosted`; these are its items
// that have always been reachable through this module.
pub use crate::hosted::{
    EffectHandler, HostedModuleInfo, ModuleGrants, DEFAULT_MODULE_DISPATCH_BUDGET,
    MAX_CASCADE_DEPTH, MAX_SUBSCRIPTIONS_PER_MODULE,
};

/// Callback type for rendering patches to the platform
pub type RenderCallback = Box<dyn Fn(&[Patch]) + Send + Sync>;

/// Send patches to the renderer through the installed render callback, if
/// any. Filters out Remove patches for elements that were Created in the same
/// batch -- this happens when a conditional re-reconciles module-scoped
/// children whose stored template doesn't carry module_scope.
fn emit_to(callback: Option<&RenderCallback>, mut patches: Vec<Patch>) {
    EngineCore::filter_spurious_removes(&mut patches);
    if let Some(callback) = callback {
        callback(&patches);
    }
}

/// The engine's render callback is where a hosted-module re-render goes (see
/// [`crate::hosted`]), so that subsystem emits patches without holding the
/// `Engine`.
impl PatchOutlet for Option<RenderCallback> {
    fn emit(&mut self, _core: &EngineCore, patches: Vec<Patch>) {
        emit_to(self.as_ref(), patches);
    }
}

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

    /// Everything held for hosted (WASM-backed) modules: the module host, the
    /// instance table, grants, subscriptions, the encoded-state cache and the
    /// cascade machinery. See [`crate::hosted`]; the methods below that deal
    /// with module instances delegate to it.
    hosted: HostedModules,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            core: EngineCore::new(),
            actions: ActionDispatcher::new(),
            resources: ResourceCache::new(),
            render_callback: None,
            last_state_weak: Weak::new(),
            hosted: HostedModules::new(),
        }
    }

    /// Split the engine into the hosted-module subsystem and the parts of the
    /// engine it works on.
    fn hosted_parts(&mut self) -> (&mut HostedModules, EngineCtx<'_>) {
        let ctx = EngineCtx {
            core: &mut self.core,
            closures: &self.actions,
            patches: &mut self.render_callback,
        };
        (&mut self.hosted, ctx)
    }

    /// Install a handler for the effects the engine surfaces but can't
    /// perform itself (`Navigate`, `Delay`, `Http`) — the host provides the
    /// router / timer / HTTP client. See [`Effect`](crate::module_host::Effect).
    /// `Log` is handled engine-side and never reaches this handler.
    ///
    /// An `Effect::Http` handed to the handler is a request in flight: the
    /// embedder performs it and reports the outcome with
    /// [`complete_http_request`](Self::complete_http_request), exactly once.
    /// With no handler installed, deferred HTTP requests are refused.
    pub fn set_effect_handler<F>(&mut self, handler: F)
    where
        F: Fn(&str, &Effect) + Send + Sync + 'static,
    {
        self.hosted.set_effect_handler(Box::new(handler));
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
    ///
    /// # Hosted subscribers
    ///
    /// When the write changes a named scope that hosted modules subscribe to
    /// (`hypen:engine/state.subscribe`), each matching subscription's
    /// `on_change` runs afterwards in its subscriber, through the same cascade
    /// (budget, depth cap, failure collection) as a reducer-output fold, with
    /// the same path matching. The host write counts as a foreign writer, so
    /// every subscriber of the scope is notified — a module subscribed to its
    /// own scope included, exactly as a fold notifies it. The state write
    /// itself always stands; notification failures are logged (`Warn`), not
    /// returned. With no subscriptions this costs one emptiness check.
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
        // Matched against the pre-write state (the patch is moved into the
        // merge below, and no state snapshot may be held across it).
        let notice = self
            .hosted
            .host_write_notice(&self.core, scope, |state, changed| {
                collect_merge_changes(state, &state_patch, &mut String::new(), changed)
            });
        if self.core.update_state(scope, state_patch, animation) {
            self.render_dirty();
            if let Some(notice) = notice {
                let (hosted, mut ctx) = self.hosted_parts();
                hosted.notify_host_write(&mut ctx, notice);
            }
        }
    }

    /// Apply a sparse state patch (path-value pairs) and re-render affected nodes.
    /// See [`update_state`] for `scope` semantics and hosted-subscriber
    /// notification.
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
        let notice = self
            .hosted
            .host_write_notice(&self.core, scope, |state, changed| {
                if let serde_json::Value::Object(map) = values {
                    for path in paths {
                        if let Some(value) = map.get(path) {
                            collect_sparse_changes(state, path, value, changed);
                        }
                    }
                }
            });
        if self
            .core
            .update_state_sparse(scope, paths, values, animation)
        {
            self.render_dirty();
            if let Some(notice) = notice {
                let (hosted, mut ctx) = self.hosted_parts();
                hosted.notify_host_write(&mut ctx, notice);
            }
        }
    }

    /// Install a WASM module host. Once installed, modules registered via
    /// [`register_module_instance`](Self::register_module_instance) handle
    /// their actions in WASM rather than via host closures.
    pub fn set_module_host(&mut self, host: Box<dyn ModuleHost>) {
        self.hosted.set_host(host);
    }

    /// Mutable access to the installed module host (for registering and
    /// instantiating module components before wiring their instances).
    pub fn module_host_mut(&mut self) -> Option<&mut (dyn ModuleHost + 'static)> {
        self.hosted.host_mut()
    }

    /// Maximum number of reducer invocations (the root action included) one
    /// top-level dispatch or lifecycle call may cause through `emit`,
    /// cross-module dispatch and subscription notifications. Default
    /// [`DEFAULT_MODULE_DISPATCH_BUDGET`].
    pub fn module_dispatch_budget(&self) -> usize {
        self.hosted.dispatch_budget()
    }

    /// Set the per-top-level-dispatch reducer-invocation budget (see
    /// [`module_dispatch_budget`](Self::module_dispatch_budget)). Clamped to
    /// at least 1 so the root action itself can always run.
    pub fn set_module_dispatch_budget(&mut self, budget: usize) {
        self.hosted.set_dispatch_budget(budget);
    }

    /// The structured failures of the most recent module cascade — a
    /// dispatch, a lifecycle call, or the subscriber notifications of a host
    /// state write — or `None` when it had none (or none ran yet).
    ///
    /// This is the data behind the `EngineError` message such a call returns:
    /// per failure the module, the action, why it was going to run and why it
    /// did not. It is also the only place the failures of a host write's
    /// notifications surface, since `update_state*` return nothing.
    pub fn last_module_cascade_report(&self) -> Option<&CascadeReport> {
        self.hosted.last_report()
    }

    /// Wire an already-instantiated WASM module instance into the engine.
    ///
    /// Seeds the module's state slot under `scope` with `initial_state` (as
    /// returned by the host's `init`) and routes the names in `actions` to
    /// this instance. A `"*"` entry makes the scope accept *any* action name
    /// (except the engine's reserved `__hypen_*` names, which must be listed
    /// explicitly). `grants` are the scope's cross-module capabilities; the
    /// engine enforces them itself when folding reducer outputs, independently
    /// of whatever the [`ModuleHost`] checked.
    ///
    /// Replaces any instance previously wired under `scope` (the caller owns
    /// destroying the old host instance) and drops the subscriptions the old
    /// instance made. Subscriptions *other* scopes hold on this scope's state
    /// are kept: they are owned and authorized by the subscriber, are keyed by
    /// scope name, and only ever dispatch into the subscriber.
    ///
    /// Errors (nothing is changed) when the scope or an action name is
    /// malformed (a scope must be non-empty, contain no `:` and not start with
    /// the reserved `__hypen_`), or `initial_state` is not a JSON object.
    pub fn register_module_instance(
        &mut self,
        scope: &str,
        id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
        initial_state: serde_json::Value,
    ) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.register(&mut ctx, scope, id, actions, grants, initial_state)
    }

    /// Re-wire an existing module scope to a new instance, **preserving the
    /// scope's current state**. Used by hot reload after the caller has
    /// instantiated a replacement via the `ModuleHost`. State stays in
    /// `EngineCore::modules` untouched; the instance id, action routing and
    /// grants are replaced, and the old instance's own subscriptions are
    /// dropped (the new instance re-subscribes on demand). Subscriptions other
    /// scopes hold on this scope are kept — see
    /// [`register_module_instance`](Self::register_module_instance).
    ///
    /// Errors (nothing is changed) when `scope` has no state slot or a name is
    /// malformed.
    pub fn rewire_module_instance(
        &mut self,
        scope: &str,
        new_id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
    ) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.rewire(&mut ctx, scope, new_id, actions, grants)
    }

    /// Return the instance id wired to a scope, if any. The result reflects
    /// the most recent `register_module_instance` / `rewire_module_instance`
    /// call, and is present even for a module that exports no actions.
    pub fn module_instance_id(&self, scope: &str) -> Option<ModuleInstanceId> {
        self.hosted.instance_id(scope)
    }

    /// Every hosted module scope with the actions it accepts, in wiring order.
    pub fn hosted_modules(&self) -> Vec<HostedModuleInfo> {
        self.hosted.describe()
    }

    /// Drive a module's `on_activated` lifecycle export for `scope` and fold
    /// the resulting [`ReducerOutput`] back into the engine — exactly as a
    /// `dispatch` output is folded (state -> reactive render, subscriptions,
    /// effects, emitted actions, cross-dispatch). This is what lets a module
    /// wire a cross-module `subscribe` (or seed effects / follow-up actions)
    /// the moment it becomes active, instead of only from an explicit UI
    /// action.
    ///
    /// No-ops when `scope` has no wired instance. Runs as a cascade root, so
    /// the error and budget semantics of
    /// [`dispatch_module_action`](Self::dispatch_module_action) apply.
    pub fn activate_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.run_lifecycle(&mut ctx, scope, LifecycleHook::Activated)
    }

    /// Drive a module's `on_deactivated` lifecycle export for `scope` and fold
    /// its output like [`activate_module`](Self::activate_module). No-ops when
    /// `scope` has no wired instance.
    pub fn deactivate_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.run_lifecycle(&mut ctx, scope, LifecycleHook::Deactivated)
    }

    /// Tear a hosted module scope down.
    ///
    /// Runs the module's `on_destroyed` export (a last chance for teardown; it
    /// returns no [`ReducerOutput`], so there is nothing to fold) and then
    /// removes everything the engine holds for the scope **whether or not the
    /// hook succeeded**: the instance entry, action routing and scoped-handler
    /// records, grants, the encoded-state cache, subscriptions in both
    /// directions (as subscriber and as target), and the scope's state slot and
    /// declarations in the core. Nothing can dispatch into the instance
    /// afterwards. The hook's error, if any, is returned after the teardown.
    ///
    /// The caller still owns the host-side instance: fetch
    /// [`module_instance_id`](Self::module_instance_id) *before* this call and
    /// pass it to [`ModuleHost::destroy`] afterwards. No-ops when `scope` has
    /// no wired instance.
    pub fn destroy_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.destroy(&mut ctx, scope)
    }

    /// Dispatch an action to its registered handler.
    ///
    /// **This is the renderer-facing entry point: `action` is treated as
    /// client-controlled input.** Every form is resolved by
    /// [`EngineCore::route_ui_action`] — the same rules that guard closure
    /// handlers — before anything runs:
    ///
    /// - a `__hypen_dispatch` envelope resolves by *node ownership* to
    ///   `__hypen_scoped:<scope>:<name>`;
    /// - a `__hypen_scoped:<scope>:<name>` name must be a registered scoped
    ///   handler;
    /// - a bare name resolves to its scoped handler only when exactly one
    ///   scope registered it (two owners → `ActionNotFound`, never a guess).
    ///
    /// If the resolved scoped name belongs to a hosted module instance (see
    /// [`register_module_instance`](Self::register_module_instance)) it drives
    /// that module's reducer; otherwise it goes to the closure
    /// [`ActionDispatcher`]. There is no `scope:action` qualifier and no
    /// sender-node shortcut here: both would bypass the ownership checks.
    /// Trusted embedder code that needs to address a scope directly uses
    /// [`dispatch_module_action`](Self::dispatch_module_action).
    ///
    /// With no module instance wired, this is exactly `route_ui_action` +
    /// closure dispatch.
    pub fn dispatch_action(&mut self, action: Action) -> Result<(), EngineError> {
        // No hosted module: exactly `route_ui_action` + closure dispatch.
        if self.hosted.is_empty() {
            let action = self.core.route_ui_action(action)?;
            return self.actions.dispatch(&action);
        }
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.dispatch_ui_action(&mut ctx, action)
    }

    /// Dispatch an action received from an **untrusted client** — the entry
    /// a Remote UI server feeds wire input to.
    ///
    /// Unlike [`dispatch_action`](Self::dispatch_action) (same trust domain
    /// as the app: an in-process renderer, or host code), this accepts only a
    /// `__hypen_dispatch` envelope whose live node itself carries the action
    /// binding; a pre-scoped `__hypen_scoped:` name or a bare name is refused.
    /// See [`EngineCore::route_client_action`] for the full rule. The resolved
    /// action then runs exactly as `dispatch_action` would run it.
    pub fn dispatch_client_action(&mut self, action: Action) -> Result<(), EngineError> {
        let action = self.core.route_client_action(action)?;
        if self.hosted.is_empty() {
            return self.actions.dispatch(&action);
        }
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.dispatch_routed(&mut ctx, action)
    }

    /// [`dispatch_client_action`](Self::dispatch_client_action) for hosts that
    /// own their dispatch loop: authorise and resolve, run nothing. The result
    /// is trusted input for [`dispatch_action`](Self::dispatch_action).
    pub fn resolve_client_action(&self, action: Action) -> Result<Action, EngineError> {
        self.core.route_client_action(action)
    }

    /// Dispatch `name` straight to the hosted module wired under `scope`.
    ///
    /// **Host-trusted API** for embedders: REPLs, timers resuming an
    /// [`Effect::Delay`], tests, server-side glue. It skips the renderer
    /// ownership checks of [`dispatch_action`](Self::dispatch_action), so never
    /// feed it a scope or name taken from client/renderer input. `name` is an
    /// opaque action name — it is never parsed for qualifiers.
    ///
    /// # Cascade semantics
    ///
    /// The reducer's output is folded into the engine and its follow-ups
    /// (`emit`, cross-module dispatch, subscriber notifications) are drained
    /// from a FIFO queue until it is empty, bounded by a depth cap
    /// ([`MAX_CASCADE_DEPTH`]) and a total reducer-invocation budget
    /// ([`module_dispatch_budget`](Self::module_dispatch_budget)).
    ///
    /// - If the **root** action fails (unknown scope/action, host error, or an
    ///   invalid returned state) the error is returned and nothing is applied.
    /// - If a **follow-up** fails, is refused by an ACL, or a cap is hit, the
    ///   rest of the queue is still drained; the failures are logged and
    ///   returned together as one `EngineError::ModuleError` afterwards (one
    ///   line per failure: module, action, why). State applied by the steps
    ///   that succeeded stays applied. The same failures are available as
    ///   data from [`last_module_cascade_report`](Self::last_module_cascade_report).
    pub fn dispatch_module_action(
        &mut self,
        scope: &str,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.dispatch_trusted(&mut ctx, scope, name, payload)
    }

    /// Complete a deferred HTTP request (`hypen:http/deferred`): the trusted
    /// entry the embedder calls once it has performed the request an
    /// [`Effect::Http`](crate::module_host::Effect::Http) handed it.
    ///
    /// Builds the completion payload documented in
    /// `wit/deps/hypen-http/http.wit` from `outcome`, releases the module's
    /// in-flight slot and runs the request's `then` action in the module that
    /// queued it — a cascade root like
    /// [`dispatch_module_action`](Self::dispatch_module_action), with the
    /// same error semantics and the same
    /// [report](Self::last_module_cascade_report).
    ///
    /// - `Ok(Delivered)`: `then` ran.
    /// - `Ok(ModuleGone)`: the module was destroyed or reloaded while the
    ///   request was in flight; the outcome was dropped (and logged).
    /// - `Err(UnknownRequest)`: no request is in flight under `id` — never
    ///   issued, or completed already. Nothing ran.
    /// - `Err(Cascade(e))`: `then` was delivered and its cascade failed.
    ///
    /// A response the contract cannot carry is delivered as the matching
    /// failure (a body over `MAX_HTTP_RESPONSE_BODY_BYTES` as `too-large`).
    pub fn complete_http_request(
        &mut self,
        id: HttpRequestId,
        outcome: HttpOutcome,
    ) -> Result<HttpDelivery, HttpCompletionError> {
        let (hosted, mut ctx) = self.hosted_parts();
        hosted.complete_http(&mut ctx, id, outcome)
    }

    /// Whether the deferred HTTP request in flight under `id` may be
    /// redirected to `url`, by the grant of the module that queued it. `None`
    /// for an id that is not in flight. (An embedder that kept the
    /// [`HttpEffect`](crate::module_host::HttpEffect) can ask its `grant`
    /// directly, without the engine.)
    pub fn http_redirect_check(
        &self,
        id: HttpRequestId,
        url: &HttpUrl,
    ) -> Option<Result<(), HttpDenial>> {
        self.hosted.http_redirect_check(id, url)
    }

    /// How many deferred HTTP requests one module may have in flight
    /// (default `DEFAULT_HTTP_IN_FLIGHT_PER_MODULE`). Further requests are
    /// refused — reported as `FailureCause::HttpLimit` and completed to the
    /// module as `denied` — until one completes.
    pub fn module_http_in_flight_limit(&self) -> usize {
        self.hosted.http_in_flight_limit()
    }

    /// Set the per-module in-flight cap (clamped to at least 1).
    pub fn set_module_http_in_flight_limit(&mut self, limit: usize) {
        self.hosted.set_http_in_flight_limit(limit);
    }

    /// How many deferred HTTP requests the module under `scope` has in
    /// flight right now.
    pub fn module_http_in_flight(&self, scope: &str) -> usize {
        self.hosted.http_in_flight(scope)
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

    /// Send patches to the renderer (see [`emit_to`]).
    fn emit_patches(&self, patches: Vec<Patch>) {
        emit_to(self.render_callback.as_ref(), patches);
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
