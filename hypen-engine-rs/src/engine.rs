use crate::{
    action_routing::{scoped_action_name, split_scoped_action, wildcard_covers, UI_ACTION},
    dispatch::{Action, ActionDispatcher},
    engine_core::EngineCore,
    error::EngineError,
    ir::{ComponentRegistry, IRNode, NodeId, ResourceRegistry},
    lifecycle::{ModuleInstance, ResourceCache},
    module_host::{
        Effect, HostAction, LogLevel, ModuleHost, ModuleInstanceId, ModuleManifest, ReducerOutput,
        SiblingState, SubscribeRequest,
    },
    reconcile::Patch,
    state::StateChange,
};
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, VecDeque};
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

    /// Hosted module instances by (lowercased) scope — the source of truth
    /// for which scopes are WASM-backed: instance id, accepted actions,
    /// wildcard flag and cross-module grants. A module that exports no
    /// actions still has an entry, so its lifecycle hooks run and a reload
    /// can find the old instance.
    module_instances: IndexMap<String, HostedModule>,

    /// Optional host hook for engine-native effects the engine can't perform
    /// on its own — `Navigate` (needs the host's router) and `Delay` (needs a
    /// timer). Called from [`perform_effect`](Self::perform_effect) with the
    /// originating module scope. `Log` stays engine-native and does not go
    /// through this hook. When unset, `Navigate`/`Delay` are logged only.
    on_effect: Option<EffectHandler>,

    /// Active cross-module subscriptions (via `hypen:engine/state.subscribe`).
    /// Fired when a target's state changes at the watched path. A scope's own
    /// subscriptions are dropped when it is re-registered or re-wired; both
    /// directions are dropped by [`Engine::destroy_module`].
    subscriptions: Vec<Subscription>,

    /// Per-scope cache of JSON-encoded module state, so a dispatch does not
    /// re-serialize state that has not changed. See
    /// [`Engine::checkout_encoded`] for the (hook-free) invalidation rule.
    encoded_states: HashMap<String, EncodedState>,

    /// Reducer-invocation budget per top-level dispatch / lifecycle call.
    module_dispatch_budget: usize,

    /// True while a module cascade is draining (re-entrancy guard).
    cascade_active: bool,
}

/// The cross-module capabilities the engine enforces for one hosted scope.
///
/// Mirrors the `reads` / `dispatches` lists of a [`ModuleManifest`]. The
/// engine checks them itself when it folds a reducer's output (cross-module
/// dispatch, `subscribe`) and uses `reads` to decide which sibling snapshots a
/// module is handed at all — it does not rely on the [`ModuleHost`] having
/// enforced them. Names are module scopes and compare case-insensitively;
/// there is no wildcard.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleGrants {
    /// Scopes whose state this module may read and subscribe to.
    pub reads: Vec<String>,
    /// Scopes this module may dispatch actions to.
    pub dispatches: Vec<String>,
}

impl ModuleGrants {
    /// No cross-module access at all.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn new<R, D>(reads: R, dispatches: D) -> Self
    where
        R: IntoIterator,
        R::Item: Into<String>,
        D: IntoIterator,
        D::Item: Into<String>,
    {
        Self {
            reads: reads.into_iter().map(Into::into).collect(),
            dispatches: dispatches.into_iter().map(Into::into).collect(),
        }
    }

    /// Lowercased (module scopes are lowercase engine-side) and de-duplicated.
    fn normalized(self) -> Self {
        fn norm(names: Vec<String>) -> Vec<String> {
            let mut out: Vec<String> = Vec::with_capacity(names.len());
            for name in names {
                let name = name.to_lowercase();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            out
        }
        Self {
            reads: norm(self.reads),
            dispatches: norm(self.dispatches),
        }
    }
}

impl From<&ModuleManifest> for ModuleGrants {
    fn from(manifest: &ModuleManifest) -> Self {
        Self {
            reads: manifest.reads.clone(),
            dispatches: manifest.dispatches.clone(),
        }
    }
}

/// One hosted module scope.
struct HostedModule {
    id: ModuleInstanceId,
    /// Explicitly exported action names (never contains `"*"`).
    actions: IndexSet<String>,
    /// The module's `actions()` contained `"*"`: accept any action name.
    wildcard: bool,
    grants: ModuleGrants,
}

impl HostedModule {
    fn accepts(&self, name: &str) -> bool {
        self.actions.contains(name) || (self.wildcard && wildcard_covers(name))
    }
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

/// Cached JSON encoding of a scope's state, valid while `source` still is the
/// allocation the scope's state lives in.
struct EncodedState {
    source: Weak<serde_json::Value>,
    bytes: Vec<u8>,
}

/// Which export of a hosted module a cascade step calls.
enum ModuleCall {
    Dispatch(HostAction),
    Activate,
    Deactivate,
}

impl ModuleCall {
    fn label(&self) -> &str {
        match self {
            ModuleCall::Dispatch(action) => &action.name,
            ModuleCall::Activate => "<on_activated>",
            ModuleCall::Deactivate => "<on_deactivated>",
        }
    }
}

/// A queued follow-up: run `action` in `scope`'s reducer.
struct WorkItem {
    scope: String,
    action: HostAction,
    depth: u32,
}

/// The work queue and failure log of one top-level module dispatch.
#[derive(Default)]
struct Cascade {
    queue: VecDeque<WorkItem>,
    /// The first [`MAX_REPORTED_FAILURES`] failure messages.
    failures: Vec<String>,
    failure_count: usize,
}

impl Cascade {
    fn fail(&mut self, message: String) {
        self.failure_count += 1;
        if self.failures.len() < MAX_REPORTED_FAILURES {
            self.failures.push(message);
        }
    }
}

/// How deep one top-level dispatch may chain follow-ups (root = depth 1).
/// Bounds ping-pong cycles (two modules that subscribe to each other and each
/// flip a value); fan-out is bounded separately by
/// [`Engine::module_dispatch_budget`].
pub const MAX_CASCADE_DEPTH: u32 = 32;

/// Default reducer-invocation budget of one top-level dispatch.
pub const DEFAULT_MODULE_DISPATCH_BUDGET: usize = 1024;

/// Most subscriptions a single module may hold.
pub const MAX_SUBSCRIPTIONS_PER_MODULE: usize = 256;

/// Failure messages kept verbatim per cascade (the count is always exact).
const MAX_REPORTED_FAILURES: usize = 8;

impl Engine {
    pub fn new() -> Self {
        Self {
            core: EngineCore::new(),
            actions: ActionDispatcher::new(),
            resources: ResourceCache::new(),
            render_callback: None,
            last_state_weak: Weak::new(),
            module_host: None,
            module_instances: IndexMap::new(),
            on_effect: None,
            subscriptions: Vec::new(),
            encoded_states: HashMap::new(),
            module_dispatch_budget: DEFAULT_MODULE_DISPATCH_BUDGET,
            cascade_active: false,
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

    /// Maximum number of reducer invocations (the root action included) one
    /// top-level dispatch or lifecycle call may cause through `emit`,
    /// cross-module dispatch and subscription notifications. Default
    /// [`DEFAULT_MODULE_DISPATCH_BUDGET`].
    pub fn module_dispatch_budget(&self) -> usize {
        self.module_dispatch_budget
    }

    /// Set the per-top-level-dispatch reducer-invocation budget (see
    /// [`module_dispatch_budget`](Self::module_dispatch_budget)). Clamped to
    /// at least 1 so the root action itself can always run.
    pub fn set_module_dispatch_budget(&mut self, budget: usize) {
        self.module_dispatch_budget = budget.max(1);
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
    /// malformed, or `initial_state` is not a JSON object.
    pub fn register_module_instance(
        &mut self,
        scope: &str,
        id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
        initial_state: serde_json::Value,
    ) -> Result<(), EngineError> {
        self.reject_during_cascade("register_module_instance")?;
        let scope = scope.to_lowercase();
        validate_hosted_names(&scope, &actions)?;
        if !initial_state.is_object() {
            return Err(EngineError::StateError(format!(
                "[{scope}] module state must be a JSON object"
            )));
        }
        self.unwire_module(&scope);
        self.subscriptions.retain(|sub| sub.subscriber != scope);
        let declared: Vec<String> = actions.iter().filter(|a| *a != "*").cloned().collect();
        let module = crate::lifecycle::Module::new(&scope).with_actions(declared);
        let instance = ModuleInstance::new(module, initial_state);
        self.core.register_module(&scope, instance);
        self.wire_module(scope, id, actions, grants);
        Ok(())
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
        self.reject_during_cascade("rewire_module_instance")?;
        let scope = scope.to_lowercase();
        validate_hosted_names(&scope, &actions)?;
        if !self.core.modules.contains_key(&scope) {
            return Err(EngineError::ModuleError(format!(
                "[{scope}] cannot rewire: no module state registered under this scope"
            )));
        }
        self.unwire_module(&scope);
        self.subscriptions.retain(|sub| sub.subscriber != scope);
        self.wire_module(scope, new_id, actions, grants);
        Ok(())
    }

    /// Record `scope` as hosted by instance `id`. Each explicit action name is
    /// also noted as a scoped handler in the core, and a wildcard scope is
    /// flagged there, so [`EngineCore::route_ui_action`] resolves renderer
    /// envelopes for nodes this module owns instead of failing closed.
    fn wire_module(
        &mut self,
        scope: String,
        id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
    ) {
        let mut wildcard = false;
        let mut names = IndexSet::with_capacity(actions.len());
        for action in actions {
            if action == "*" {
                wildcard = true;
            } else {
                self.core.note_handler(&scoped_action_name(&scope, &action));
                names.insert(action);
            }
        }
        if wildcard && !self.core.wildcard_action_scopes.contains(&scope) {
            self.core.wildcard_action_scopes.push(scope.clone());
        }
        self.module_instances.insert(
            scope,
            HostedModule {
                id,
                actions: names,
                wildcard,
                grants: grants.normalized(),
            },
        );
    }

    /// Forget the instance wired under `scope`: its instance entry, action
    /// routing, grants, wildcard flag, encoded-state cache and the
    /// scoped-handler records [`wire_module`](Self::wire_module) added (unless
    /// a closure handler is registered under the same scoped name).
    fn unwire_module(&mut self, scope: &str) {
        self.encoded_states.remove(scope);
        self.core.wildcard_action_scopes.retain(|s| s != scope);
        let Some(hosted) = self.module_instances.shift_remove(scope) else {
            return;
        };
        for action in &hosted.actions {
            let scoped = scoped_action_name(scope, action);
            if !self.actions.has_handler(&scoped) {
                self.core.registered_actions.retain(|a| a != &scoped);
            }
        }
    }

    /// Return the instance id wired to a scope, if any. The result reflects
    /// the most recent `register_module_instance` / `rewire_module_instance`
    /// call, and is present even for a module that exports no actions.
    pub fn module_instance_id(&self, scope: &str) -> Option<ModuleInstanceId> {
        self.module_instances
            .get(scope.to_lowercase().as_str())
            .map(|m| m.id)
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
        let scope = scope.to_lowercase();
        if !self.module_instances.contains_key(&scope) {
            return Ok(());
        }
        self.run_cascade(scope, ModuleCall::Activate)
    }

    /// Drive a module's `on_deactivated` lifecycle export for `scope` and fold
    /// its output like [`activate_module`](Self::activate_module). No-ops when
    /// `scope` has no wired instance.
    pub fn deactivate_module(&mut self, scope: &str) -> Result<(), EngineError> {
        let scope = scope.to_lowercase();
        if !self.module_instances.contains_key(&scope) {
            return Ok(());
        }
        self.run_cascade(scope, ModuleCall::Deactivate)
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
        self.reject_during_cascade("destroy_module")?;
        let scope = scope.to_lowercase();
        let Some(id) = self.module_instances.get(&scope).map(|m| m.id) else {
            return Ok(());
        };
        let hook = match (self.checkout_encoded(&scope), self.module_host.as_mut()) {
            (Some((_, bytes)), Some(host)) => host
                .on_destroyed(id, &bytes)
                .map_err(|e| EngineError::ModuleError(e.to_string())),
            (None, Some(host)) => host
                .on_destroyed(id, b"{}")
                .map_err(|e| EngineError::ModuleError(e.to_string())),
            (_, None) => Err(EngineError::ModuleError(
                "no module host installed".into(),
            )),
        };
        self.unwire_module(&scope);
        self.subscriptions
            .retain(|sub| sub.subscriber != scope && sub.target != scope);
        crate::agent_core::unregister_module(&mut self.core, &scope);
        hook
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
        // A bare name several hosted modules export would be refused by
        // `route_ui_action` as ambiguous anyway; refuse it here with a message
        // that names the owners.
        if !self.module_instances.is_empty()
            && action.name != UI_ACTION
            && split_scoped_action(&action.name).is_none()
        {
            let owners: Vec<&str> = self
                .module_instances
                .iter()
                .filter(|(_, module)| module.actions.contains(&action.name))
                .map(|(scope, _)| scope.as_str())
                .collect();
            if owners.len() > 1 {
                return Err(EngineError::ModuleError(format!(
                    "action '{}' is exported by multiple modules ({}); dispatch it from a \
                     node of the owning module (a `{UI_ACTION}` envelope) or address the \
                     scope with `dispatch_module_action`",
                    action.name,
                    owners.join(", "),
                )));
            }
        }
        let action = self.core.route_ui_action(action)?;
        if !self.module_instances.is_empty() {
            let hit = split_scoped_action(&action.name).filter(|(scope, name)| {
                self.module_instances
                    .get(*scope)
                    .is_some_and(|m| m.accepts(name))
            });
            if let Some((scope, name)) = hit {
                let (scope, name) = (scope.to_string(), name.to_string());
                return self.run_cascade(
                    scope,
                    ModuleCall::Dispatch(HostAction::new(name, encode_payload(action.payload))),
                );
            }
        }
        self.actions.dispatch(&action)
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
    ///   returned together as one `EngineError::ModuleError` afterwards. State
    ///   applied by the steps that succeeded stays applied.
    pub fn dispatch_module_action(
        &mut self,
        scope: &str,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        let scope = scope.to_lowercase();
        let accepts = self
            .module_instances
            .get(&scope)
            .ok_or_else(|| {
                EngineError::ActionNotFound(format!("no hosted module under scope '{scope}'"))
            })?
            .accepts(name);
        if !accepts {
            return Err(EngineError::ActionNotFound(format!(
                "module '{scope}' does not accept action '{name}'"
            )));
        }
        self.run_cascade(
            scope,
            ModuleCall::Dispatch(HostAction::new(name, encode_payload(Some(payload)))),
        )
    }

    /// Structural mutations of the hosted-module table are refused while a
    /// cascade is draining. `&mut self` already makes that statically
    /// unreachable from safe Rust (no callback is handed the engine); the flag
    /// turns a future regression into a clear error instead of a corrupted
    /// queue.
    fn reject_during_cascade(&self, what: &str) -> Result<(), EngineError> {
        if self.cascade_active {
            return Err(EngineError::ModuleError(format!(
                "{what} called while a module dispatch cascade is running"
            )));
        }
        Ok(())
    }

    /// Run one top-level module call and drain everything it causes.
    ///
    /// Re-entrancy: a second cascade cannot start while one is draining (it is
    /// rejected with an error). No engine callback receives `&mut Engine`, so
    /// this is unreachable from safe code today; follow-ups a reducer wants
    /// are expressed in its [`ReducerOutput`] and join the running queue.
    fn run_cascade(&mut self, scope: String, call: ModuleCall) -> Result<(), EngineError> {
        self.reject_during_cascade("module dispatch")?;
        self.cascade_active = true;
        let result = self.drain_cascade(scope, call);
        self.cascade_active = false;
        result
    }

    fn drain_cascade(&mut self, scope: String, call: ModuleCall) -> Result<(), EngineError> {
        let root_label = format!("[{scope}] {}", call.label());
        let mut cascade = Cascade::default();
        let mut budget = self.module_dispatch_budget.max(1);

        // Root: any failure is the caller's error and nothing is applied.
        let output = self.invoke(&scope, call)?;
        budget -= 1;
        self.fold_output(&scope, output, 1, &mut cascade)?;

        // Follow-ups: FIFO, each failure recorded, the queue always drained.
        while let Some(item) = cascade.queue.pop_front() {
            if budget == 0 {
                let dropped = cascade.queue.len() + 1;
                cascade.queue.clear();
                cascade.fail(format!(
                    "reducer-invocation budget ({}) exhausted; dropped {dropped} pending \
                     action(s), first '[{}] {}'",
                    self.module_dispatch_budget, item.scope, item.action.name
                ));
                break;
            }
            budget -= 1;
            let label = format!("[{}] {}", item.scope, item.action.name);
            let step = self
                .invoke(&item.scope, ModuleCall::Dispatch(item.action))
                .and_then(|output| self.fold_output(&item.scope, output, item.depth, &mut cascade));
            if let Err(e) = step {
                cascade.fail(format!("{label}: {e}"));
            }
        }

        if cascade.failure_count == 0 {
            return Ok(());
        }
        for failure in &cascade.failures {
            crate::logger::log(
                crate::logger::LogLevel::Warn,
                crate::logger::LogScope::Engine,
                &format!("module cascade from {root_label}: {failure}"),
            );
        }
        let mut summary = format!(
            "module cascade from {root_label} finished with {} failure(s): {}",
            cascade.failure_count,
            cascade.failures.join("; ")
        );
        if cascade.failure_count > cascade.failures.len() {
            summary.push_str("; ...");
        }
        Err(EngineError::ModuleError(summary))
    }

    /// Call one export of the instance wired under `scope`, handing it the
    /// scope's state and the sibling snapshots its `reads` grant names — and
    /// nothing else. All bytes come from the encoded-state cache.
    fn invoke(&mut self, scope: &str, call: ModuleCall) -> Result<ReducerOutput, EngineError> {
        let hosted = self.module_instances.get(scope).ok_or_else(|| {
            EngineError::ModuleError(format!("no hosted module under scope '{scope}'"))
        })?;
        let id = hosted.id;
        let read_names: Vec<String> = if matches!(call, ModuleCall::Deactivate) {
            Vec::new()
        } else {
            hosted
                .grants
                .reads
                .iter()
                .filter(|name| name.as_str() != scope)
                .cloned()
                .collect()
        };
        if self.module_host.is_none() {
            return Err(EngineError::ModuleError("no module host installed".into()));
        }
        let (own_source, own_bytes) = self.checkout_encoded(scope).ok_or_else(|| {
            EngineError::StateError(format!("[{scope}] module has no state slot"))
        })?;
        let mut sources = Vec::with_capacity(read_names.len());
        let mut siblings: Vec<SiblingState> = Vec::with_capacity(read_names.len());
        for name in read_names {
            if let Some((source, bytes)) = self.checkout_encoded(&name) {
                sources.push(source);
                siblings.push((name, bytes));
            }
        }

        let host = self.module_host.as_mut().expect("checked above");
        let result = match call {
            ModuleCall::Dispatch(action) => host.dispatch(id, &own_bytes, action, &siblings),
            ModuleCall::Activate => host.on_activated(id, &own_bytes, &siblings),
            ModuleCall::Deactivate => host.on_deactivated(id, &own_bytes),
        };

        self.checkin_encoded(scope, own_source, own_bytes);
        for ((name, bytes), source) in siblings.into_iter().zip(sources) {
            self.checkin_encoded(&name, source, bytes);
        }
        result.map_err(|e| EngineError::ModuleError(e.to_string()))
    }

    /// Borrow `scope`'s JSON-encoded state out of the cache, encoding it only
    /// when the cached bytes are stale. Pair with
    /// [`checkin_encoded`](Self::checkin_encoded).
    ///
    /// Staleness needs no invalidation hook: the entry holds a `Weak` to the
    /// state `Arc` it was encoded from, and every state write goes through
    /// `Arc::make_mut` (which must move to a fresh allocation while a `Weak`
    /// exists) or installs a new `Arc`. So "same allocation" is exactly
    /// "unchanged since encoding", whichever engine API did the write — and a
    /// live `Weak` pins the old allocation, so its address is never reused.
    fn checkout_encoded(&mut self, scope: &str) -> Option<(Weak<serde_json::Value>, Vec<u8>)> {
        let Some(instance) = self.core.modules.get(scope) else {
            self.encoded_states.remove(scope);
            return None;
        };
        let mut buffer = Vec::new();
        if let Some(entry) = self.encoded_states.get_mut(scope) {
            buffer = std::mem::take(&mut entry.bytes);
            if std::ptr::eq(entry.source.as_ptr(), instance.get_state()) {
                return Some((entry.source.clone(), buffer));
            }
            buffer.clear();
        }
        serde_json::to_writer(&mut buffer, instance.get_state()).ok()?;
        Some((Arc::downgrade(&instance.get_state_shared()), buffer))
    }

    fn checkin_encoded(&mut self, scope: &str, source: Weak<serde_json::Value>, bytes: Vec<u8>) {
        match self.encoded_states.get_mut(scope) {
            Some(entry) => {
                entry.source = source;
                entry.bytes = bytes;
            }
            None => {
                self.encoded_states
                    .insert(scope.to_string(), EncodedState { source, bytes });
            }
        }
    }

    /// Fold one [`ReducerOutput`] of `scope` into the engine and enqueue its
    /// follow-ups at `depth + 1`.
    ///
    /// Returns `Err` — with nothing applied — only when the returned state is
    /// unusable (not JSON, or not an object). Refused follow-ups (ACL, unknown
    /// target, depth cap) and refused subscriptions are recorded on `cascade`
    /// and never stop the rest of the output from being applied.
    fn fold_output(
        &mut self,
        scope: &str,
        output: ReducerOutput,
        depth: u32,
        cascade: &mut Cascade,
    ) -> Result<(), EngineError> {
        // 1. State. The reducer returned its whole new state, so the scope's
        //    subtree is replaced wholesale — the engine's copy is then exactly
        //    what the module returned. The old→new comparison only produces
        //    the changed-path set for binding invalidation and subscribers.
        let mut notify: Vec<(String, String)> = Vec::new();
        if let Some(new_bytes) = output.state {
            let new_state: serde_json::Value = serde_json::from_slice(&new_bytes)
                .map_err(|e| EngineError::StateError(format!("[{scope}] invalid state: {e}")))?;
            if !new_state.is_object() {
                return Err(EngineError::StateError(format!(
                    "[{scope}] module state must be a JSON object"
                )));
            }
            let old_state = self.core.get_module_state(scope).ok_or_else(|| {
                EngineError::StateError(format!("[{scope}] module has no state slot"))
            })?;
            let mut changed = Vec::new();
            collect_changed_paths(old_state, &new_state, &mut String::new(), &mut changed);
            if !changed.is_empty() {
                self.core.replace_module_state(scope, new_state, &changed);
                self.render_dirty();
                // Snapshot who to notify *before* step 2, so a subscription
                // created by this very output does not fire on the change
                // that created it.
                notify = self
                    .subscriptions
                    .iter()
                    .filter(|s| s.target == scope)
                    .filter(|s| changed.iter().any(|p| paths_overlap(p, &s.path)))
                    .map(|s| (s.subscriber.clone(), s.on_change.clone()))
                    .collect();
            }
        }

        // 2. Subscriptions this reducer requested (subscriber = this scope).
        for request in output.subscribe_requests {
            if let Err(reason) = self.add_subscription(scope, request) {
                cascade.fail(format!("[{scope}] subscribe refused: {reason}"));
            }
        }

        // 3. Side effects the host performs directly.
        for effect in output.effects {
            self.perform_effect(scope, effect);
        }

        // 4. Follow-ups. Guest-supplied names are opaque action names: they
        //    are matched against the destination scope's action set and never
        //    parsed, qualified or re-routed.
        //    a. `emit` always targets the emitting module's own scope.
        for action in output.emit {
            self.enqueue_follow_up(scope, "emit", scope, action, depth, cascade);
        }
        //    b. Cross-dispatch needs the sender's `dispatches` grant on the
        //       target, re-checked here whatever the host enforced.
        for (target, action) in output.cross_dispatch {
            let target = target.to_lowercase();
            let granted = self
                .module_instances
                .get(scope)
                .is_some_and(|m| m.grants.dispatches.contains(&target));
            if !granted {
                cascade.fail(format!(
                    "[{scope}] dispatch to '{target}' refused: no `dispatches` grant"
                ));
                continue;
            }
            self.enqueue_follow_up(scope, "dispatch", &target, action, depth, cascade);
        }
        //    c. Subscriber notifications run in the subscriber's own scope.
        for (subscriber, on_change) in notify {
            let action = HostAction::new(on_change, b"null".to_vec());
            self.enqueue_follow_up(scope, "notify", &subscriber, action, depth, cascade);
        }
        Ok(())
    }

    /// Queue `action` for `target`, or record why it was refused.
    fn enqueue_follow_up(
        &self,
        origin: &str,
        kind: &str,
        target: &str,
        mut action: HostAction,
        depth: u32,
        cascade: &mut Cascade,
    ) {
        let accepted = self
            .module_instances
            .get(target)
            .is_some_and(|m| m.accepts(&action.name));
        if !accepted {
            cascade.fail(format!(
                "[{origin}] {kind} '{}' refused: module '{target}' does not accept that action",
                action.name
            ));
            return;
        }
        if depth >= MAX_CASCADE_DEPTH {
            cascade.fail(format!(
                "[{origin}] {kind} '{}' to '{target}' dropped: cascade depth cap \
                 ({MAX_CASCADE_DEPTH}) reached",
                action.name
            ));
            return;
        }
        // The payload crosses a module boundary as-is; make sure it is JSON.
        if serde_json::from_slice::<serde::de::IgnoredAny>(&action.payload).is_err() {
            action.payload = b"null".to_vec();
        }
        cascade.queue.push_back(WorkItem {
            scope: target.to_string(),
            action,
            depth: depth + 1,
        });
    }

    /// Register (or replace) a cross-module subscription. Replacing an existing
    /// `(subscriber, target, path)` keeps the set idempotent under repeated
    /// `subscribe` calls.
    ///
    /// Observing state is a read, so the subscriber needs its `reads` grant on
    /// the target (re-checked here whatever the host enforced). `on_change`
    /// must be an action the subscriber itself accepts, and a subscriber may
    /// hold at most [`MAX_SUBSCRIPTIONS_PER_MODULE`] subscriptions.
    fn add_subscription(&mut self, subscriber: &str, req: SubscribeRequest) -> Result<(), String> {
        let target = req.target.to_lowercase();
        let hosted = self
            .module_instances
            .get(subscriber)
            .ok_or_else(|| "subscriber is not a hosted module".to_string())?;
        if !hosted.grants.reads.contains(&target) {
            return Err(format!("no `reads` grant on '{target}'"));
        }
        if !hosted.accepts(&req.on_change) {
            return Err(format!(
                "on_change '{}' is not an action of '{subscriber}'",
                req.on_change
            ));
        }
        let existing = self
            .subscriptions
            .iter()
            .position(|s| s.subscriber == subscriber && s.target == target && s.path == req.path);
        if let Some(index) = existing {
            self.subscriptions[index].on_change = req.on_change;
            return Ok(());
        }
        let held = self
            .subscriptions
            .iter()
            .filter(|s| s.subscriber == subscriber)
            .count();
        if held >= MAX_SUBSCRIPTIONS_PER_MODULE {
            return Err(format!(
                "subscription limit ({MAX_SUBSCRIPTIONS_PER_MODULE}) reached"
            ));
        }
        self.subscriptions.push(Subscription {
            subscriber: subscriber.to_string(),
            target,
            path: req.path,
            on_change: req.on_change,
        });
        Ok(())
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
    fn is_ancestor(ancestor: &str, path: &str) -> bool {
        path.len() > ancestor.len()
            && path.as_bytes()[ancestor.len()] == b'.'
            && path.starts_with(ancestor)
    }
    changed.is_empty()
        || watched.is_empty()
        || changed == watched
        || is_ancestor(watched, changed)
        || is_ancestor(changed, watched)
}

/// JSON-encode an action payload for a module's `dispatch` export.
fn encode_payload(payload: Option<serde_json::Value>) -> Vec<u8> {
    payload
        .and_then(|value| serde_json::to_vec(&value).ok())
        .unwrap_or_else(|| b"null".to_vec())
}

/// Scope and action names a hosted module may be wired with. `:` is the
/// separator of the scoped wire name (`__hypen_scoped:<scope>:<action>`), so a
/// name containing it could alias another scope's handler record.
fn validate_hosted_names(scope: &str, actions: &[String]) -> Result<(), EngineError> {
    if scope.is_empty() || scope.contains(':') {
        return Err(EngineError::ModuleError(format!(
            "invalid module scope '{scope}': must be non-empty and contain no ':'"
        )));
    }
    for action in actions {
        if action.is_empty() || action.contains(':') || action == UI_ACTION {
            return Err(EngineError::ModuleError(format!(
                "[{scope}] invalid action name '{action}': must be non-empty, contain no ':' \
                 and not be the reserved '{UI_ACTION}'"
            )));
        }
    }
    Ok(())
}

/// Collect the dotted paths at which `new` differs from `old`, for binding
/// invalidation and subscription matching (the state itself is replaced
/// wholesale, so nothing here has to be able to *reconstruct* `new`).
///
/// - Changed, added and removed object keys report `prefix.key`.
/// - Arrays compare index by index; a shrunk array reports the array itself.
/// - A key the dotted-path system cannot address (empty, or containing `.`)
///   reports its parent instead — over-invalidating the parent rather than
///   naming a path that would alias a different, nested value. At the root
///   that is the empty path: "the whole state".
///
/// `prefix` is scratch space and is restored before returning.
fn collect_changed_paths(
    old: &serde_json::Value,
    new: &serde_json::Value,
    prefix: &mut String,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    use std::fmt::Write;

    fn with_segment<R>(prefix: &mut String, segment: &str, f: impl FnOnce(&mut String) -> R) -> R {
        let len = prefix.len();
        if len > 0 {
            prefix.push('.');
        }
        prefix.push_str(segment);
        let result = f(prefix);
        prefix.truncate(len);
        result
    }
    fn addressable(key: &str) -> bool {
        !key.is_empty() && !key.contains('.')
    }

    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            let mut parent_changed = false;
            for (key, old_value) in old_map {
                let new_value = new_map.get(key);
                if !addressable(key) {
                    parent_changed |= new_value != Some(old_value);
                    continue;
                }
                match new_value {
                    Some(new_value) => with_segment(prefix, key, |path| {
                        collect_changed_paths(old_value, new_value, path, out)
                    }),
                    None => with_segment(prefix, key, |path| out.push(path.clone())),
                }
            }
            for key in new_map.keys() {
                if old_map.contains_key(key) {
                    continue;
                }
                if addressable(key) {
                    with_segment(prefix, key, |path| out.push(path.clone()));
                } else {
                    parent_changed = true;
                }
            }
            if parent_changed {
                out.push(prefix.clone());
            }
        }
        (Value::Array(old_items), Value::Array(new_items)) => {
            if new_items.len() < old_items.len() {
                out.push(prefix.clone());
                return;
            }
            let mut segment = String::new();
            for (index, new_item) in new_items.iter().enumerate() {
                segment.clear();
                let _ = write!(segment, "{index}");
                let segment = segment.as_str();
                match old_items.get(index) {
                    Some(old_item) => with_segment(prefix, segment, |path| {
                        collect_changed_paths(old_item, new_item, path, out)
                    }),
                    None => with_segment(prefix, segment, |path| out.push(path.clone())),
                }
            }
        }
        (old, new) => {
            if old != new {
                out.push(prefix.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_changed_paths, paths_overlap};
    use serde_json::{json, Value};

    fn changed(old: Value, new: Value) -> Vec<String> {
        let mut out = Vec::new();
        let mut prefix = String::new();
        collect_changed_paths(&old, &new, &mut prefix, &mut out);
        assert!(prefix.is_empty(), "scratch prefix must be restored");
        out
    }

    #[test]
    fn paths_overlap_matches_equal_ancestor_and_descendant_paths_only() {
        assert!(paths_overlap("a.b", "a.b"));
        assert!(paths_overlap("a", "a.b"));
        assert!(paths_overlap("a.b.c", "a.b"));
        assert!(paths_overlap("", "a.b"));
        assert!(paths_overlap("a.b", ""));
        // A shared string prefix is not a shared path prefix.
        assert!(!paths_overlap("ab", "a"));
        assert!(!paths_overlap("a", "ab"));
        assert!(!paths_overlap("a.bc", "a.b"));
        assert!(!paths_overlap("a.b", "a.c"));
    }

    #[test]
    fn changed_paths_are_minimal_for_addressable_keys() {
        assert!(changed(json!({ "a": { "b": [1, 2] } }), json!({ "a": { "b": [1, 2] } })).is_empty());
        assert_eq!(
            changed(
                json!({ "a": { "b": 1, "c": 2 }, "gone": 1, "list": [1, 2] }),
                json!({ "a": { "b": 1, "c": 3 }, "new": 1, "list": [1, 5, 9] }),
            ),
            ["a.c", "gone", "list.1", "list.2", "new"]
        );
        // Shrinking reports the array itself; a type change its own path.
        assert_eq!(
            changed(
                json!({ "list": [1, 2], "t": { "x": 1 } }),
                json!({ "list": [1], "t": [1] })
            ),
            ["list", "t"]
        );
    }

    #[test]
    fn unaddressable_keys_report_their_parent() {
        assert_eq!(
            changed(json!({ "cfg": { "x": 1 } }), json!({ "cfg": { "x": 1, "a.b": 2 } })),
            ["cfg"]
        );
        assert_eq!(
            changed(json!({ "cfg": { "": 1, "a.b": 2 } }), json!({ "cfg": { "": 1 } })),
            ["cfg"]
        );
        // At the root the parent is the whole state.
        assert_eq!(changed(json!({ "a.b": 1 }), json!({ "a.b": 2 })), [""]);
        assert!(changed(json!({ "a.b": 1 }), json!({ "a.b": 1 })).is_empty());
    }
}
