//! Hosted modules: the engine-side half of WASM module hosting.
//!
//! A *hosted module* is a module scope whose reducer runs inside a
//! [`ModuleHost`] (wasmtime natively, a JS bridge in the browser) instead of
//! as host-language closures. This subsystem owns everything the engine keeps
//! for them — [`HostedModules`] — and `Engine` delegates to it. State stays
//! canonical in the engine core; a module is a pure
//! `(state, action) -> ReducerOutput` function the engine drives.
//!
//! # Contract
//!
//! **Routing.** A renderer action (`Engine::dispatch_action`, client-controlled
//! input) is first resolved by `EngineCore::route_ui_action` — by node
//! ownership, a registered scoped name, or a bare name exactly one scope
//! handles. Only if the resolved scope is hosted *and* its [`ActionSet`]
//! accepts the name does the module run; anything else goes to the closure
//! dispatcher. `Engine::dispatch_module_action` is the trusted entry that
//! addresses a scope directly. Action names are opaque: never parsed for a
//! qualifier, never re-routed.
//!
//! **Fold order** (see `fold`). State (replaced wholesale; unusable state
//! rejects the whole output) → requested subscriptions → effects → follow-ups
//! (`emit`, then cross-dispatch, then subscriber notifications).
//!
//! **Cascade** (see `cascade`). Follow-ups drain FIFO from one queue,
//! bounded by [`MAX_CASCADE_DEPTH`] and the dispatch budget
//! ([`DEFAULT_MODULE_DISPATCH_BUDGET`]). A failing root is the caller's error
//! and applies nothing; a failing follow-up is recorded in the
//! [`CascadeReport`] and blocks nothing else.
//!
//! **Trust.** The embedder is trusted: registration, `ModuleGrants`,
//! `dispatch_module_action`, `update_state*`. Guests and the renderer are
//! not: every name, target, payload and state a reducer returns is validated
//! here, and the `reads` / `dispatches` grants are re-checked by the engine
//! whatever the host enforced. A module is only ever handed its own state and
//! snapshots of the scopes its `reads` grant names.
//!
//! # Layout
//!
//! | module | owns |
//! |---|---|
//! | `names` | [`ScopeName`], [`ActionSet`] — validated once at the boundary |
//! | `registry` | the instance table, [`ModuleGrants`], routing records in the core |
//! | `cascade` | the work queue, budget and depth caps, the drain loop, the host call |
//! | `fold` | applying one reducer output |
//! | `subscriptions` | cross-module subscriptions and who a change notifies |
//! | `snapshots` | the encoded-state cache lent to host calls |
//! | `paths` | changed-path collection and overlap |
//! | `report` | [`CascadeReport`] and its failure types |

pub(crate) mod cascade;
pub(crate) mod fold;
pub(crate) mod names;
pub(crate) mod paths;
pub(crate) mod registry;
pub(crate) mod report;
pub(crate) mod snapshots;
pub(crate) mod subscriptions;

#[cfg(test)]
mod tests;

pub use names::{ActionSet, InvalidName, ScopeName};
pub use registry::ModuleGrants;
pub use report::{
    CascadeFailure, CascadeReport, CascadeRoot, FailureCause, InvalidState, LifecycleHook, Origin,
    MAX_REPORTED_FAILURES,
};

use crate::action_routing::{split_scoped_action, UI_ACTION};
use crate::dispatch::{Action, ActionDispatcher};
use crate::engine::PatchSink;
use crate::engine_core::EngineCore;
use crate::error::EngineError;
use crate::lifecycle::{Module, ModuleInstance};
use crate::module_host::{Effect, HostAction, ModuleHost, ModuleInstanceId};
use cascade::{Call, Cascade};
use names::canonical_scope;
use registry::{Grants, HostedModule, Registry};
use snapshots::EncodedStates;
use subscriptions::{Notification, Subscriptions};

/// How deep one top-level dispatch may chain follow-ups (root = depth 1).
/// Bounds ping-pong cycles (two modules that subscribe to each other and each
/// flip a value); fan-out is bounded separately by the dispatch budget.
pub const MAX_CASCADE_DEPTH: u32 = 32;

/// Default reducer-invocation budget of one top-level dispatch.
pub const DEFAULT_MODULE_DISPATCH_BUDGET: usize = 1024;

/// Most subscriptions a single module may hold.
pub const MAX_SUBSCRIPTIONS_PER_MODULE: usize = 256;

/// Handler for engine-native effects (`Navigate` / `Delay`) the host performs.
/// Receives the originating module scope and the effect.
pub type EffectHandler = Box<dyn Fn(&str, &Effect) + Send + Sync>;

/// The parts of the engine a hosted-module operation works on, besides the
/// subsystem's own state. Built by `Engine` per call; a test can build one
/// from a bare [`EngineCore`].
pub(crate) struct EngineCtx<'a> {
    /// State slots, routing records, the reactive graph.
    pub(crate) core: &'a mut EngineCore,
    /// Closure handlers: where a routed action goes when no hosted module
    /// takes it, and whose scoped names an unwire must leave registered.
    pub(crate) closures: &'a ActionDispatcher,
    /// Where patches of a re-render go.
    pub(crate) patches: PatchSink<'a>,
}

impl EngineCtx<'_> {
    /// Re-render the nodes a state write left dirty and emit their patches.
    pub(crate) fn render_dirty(&mut self) {
        let patches = self.core.render_dirty();
        if !patches.is_empty() {
            self.patches.emit(patches);
        }
    }
}

/// Whether a cascade is draining (the re-entrancy guard).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CascadeState {
    Idle,
    Draining,
}

/// A host state write that subscribers must be told about: the output of
/// [`HostedModules::host_write_notice`], consumed by
/// [`HostedModules::notify_host_write`] once the write has been applied.
pub(crate) struct HostWriteNotice {
    /// Canonical name of the written scope.
    scope: String,
    notifications: Vec<Notification>,
}

/// Everything the engine holds for hosted modules.
pub(crate) struct HostedModules {
    /// The module host, once installed. Modules registered with
    /// [`register`](Self::register) run through it.
    host: Option<Box<dyn ModuleHost>>,
    registry: Registry,
    subscriptions: Subscriptions,
    snapshots: EncodedStates,
    /// Embedder hook for the effects the engine cannot perform itself.
    on_effect: Option<EffectHandler>,
    /// Reducer-invocation budget per top-level dispatch / lifecycle call.
    dispatch_budget: usize,
    cascade_state: CascadeState,
    /// The report of the most recent cascade, if it had failures.
    last_report: Option<CascadeReport>,
}

impl Default for HostedModules {
    fn default() -> Self {
        Self::new()
    }
}

impl HostedModules {
    pub(crate) fn new() -> Self {
        Self {
            host: None,
            registry: Registry::default(),
            subscriptions: Subscriptions::default(),
            snapshots: EncodedStates::default(),
            on_effect: None,
            dispatch_budget: DEFAULT_MODULE_DISPATCH_BUDGET,
            cascade_state: CascadeState::Idle,
            last_report: None,
        }
    }

    // ── configuration ───────────────────────────────────────────────────────

    pub(crate) fn set_host(&mut self, host: Box<dyn ModuleHost>) {
        self.host = Some(host);
    }

    pub(crate) fn host_mut(&mut self) -> Option<&mut (dyn ModuleHost + 'static)> {
        self.host.as_deref_mut()
    }

    pub(crate) fn set_effect_handler(&mut self, handler: EffectHandler) {
        self.on_effect = Some(handler);
    }

    pub(crate) fn dispatch_budget(&self) -> usize {
        self.dispatch_budget
    }

    /// Clamped to at least 1 so a root action can always run.
    pub(crate) fn set_dispatch_budget(&mut self, budget: usize) {
        self.dispatch_budget = budget.max(1);
    }

    /// Whether no module instance is wired — the fast-path check of
    /// `Engine::dispatch_action`.
    pub(crate) fn is_empty(&self) -> bool {
        self.registry.is_empty()
    }

    pub(crate) fn instance_id(&self, scope: &str) -> Option<ModuleInstanceId> {
        self.registry.resolve(scope).map(|(_, module)| module.id)
    }

    /// The failures of the most recent cascade (dispatch, lifecycle call or
    /// host-write notification); `None` when it had none.
    pub(crate) fn last_report(&self) -> Option<&CascadeReport> {
        self.last_report.as_ref()
    }

    // ── registration and teardown ───────────────────────────────────────────

    /// Wire instance `id` under `scope` with a fresh state slot seeded from
    /// `initial_state`. See `Engine::register_module_instance`.
    pub(crate) fn register(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &str,
        id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
        initial_state: serde_json::Value,
    ) -> Result<(), EngineError> {
        self.reject_during_cascade("register_module_instance")?;
        let WiringNames { scope, actions } = WiringNames::parse(scope, actions)?;
        if !initial_state.is_object() {
            return Err(EngineError::StateError(format!(
                "[{scope}] module state must be a JSON object"
            )));
        }
        self.unwire(ctx, scope.as_str());
        self.subscriptions.drop_made_by(scope.as_str());
        let declared: Vec<String> = actions.named().iter().cloned().collect();
        let module = Module::new(scope.as_str()).with_actions(declared);
        ctx.core
            .register_module(scope.as_str(), ModuleInstance::new(module, initial_state));
        let module = HostedModule {
            id,
            actions,
            grants: Grants::from(grants),
        };
        self.registry.wire(ctx.core, scope, module);
        Ok(())
    }

    /// Point an existing scope at instance `new_id`, keeping its state. See
    /// `Engine::rewire_module_instance`.
    pub(crate) fn rewire(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &str,
        new_id: ModuleInstanceId,
        actions: Vec<String>,
        grants: ModuleGrants,
    ) -> Result<(), EngineError> {
        self.reject_during_cascade("rewire_module_instance")?;
        let WiringNames { scope, actions } = WiringNames::parse(scope, actions)?;
        if !ctx.core.modules.contains_key(scope.as_str()) {
            return Err(EngineError::ModuleError(format!(
                "[{scope}] cannot rewire: no module state registered under this scope"
            )));
        }
        self.unwire(ctx, scope.as_str());
        self.subscriptions.drop_made_by(scope.as_str());
        let module = HostedModule {
            id: new_id,
            actions,
            grants: Grants::from(grants),
        };
        self.registry.wire(ctx.core, scope, module);
        Ok(())
    }

    /// Forget the instance wired under `scope` (canonical) and its cached
    /// encoded state. Subscriptions and the state slot are the caller's call.
    fn unwire(&mut self, ctx: &mut EngineCtx<'_>, scope: &str) -> Option<HostedModule> {
        self.snapshots.forget(scope);
        self.registry.unwire(ctx.core, ctx.closures, scope)
    }

    /// Run `on_destroyed` and remove everything held for `scope`, whether or
    /// not the hook succeeded. See `Engine::destroy_module`.
    pub(crate) fn destroy(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &str,
    ) -> Result<(), EngineError> {
        self.reject_during_cascade("destroy_module")?;
        let Some((scope, module)) = self.registry.resolve(scope) else {
            return Ok(());
        };
        let (scope, id) = (scope.clone(), module.id);
        let scope = scope.as_str();

        // The hook gets the scope's last state; a scope whose slot is already
        // gone still gets its teardown call, with an empty object.
        let lease = self.snapshots.checkout(ctx.core, scope).ok();
        let state: &[u8] = lease
            .as_ref()
            .map_or(b"{}".as_slice(), |lease| lease.bytes());
        let hook = match self.host.as_deref_mut() {
            Some(host) => host.on_destroyed(id, state).map_err(|e| e.to_string()),
            None => Err("no module host installed".to_string()),
        };

        self.unwire(ctx, scope);
        self.subscriptions.drop_involving(scope);
        crate::agent_core::unregister_module(ctx.core, scope);
        hook.map_err(|e| {
            EngineError::ModuleError(format!("[{scope}] '<on_destroyed>' failed: {e}"))
        })
    }

    // ── dispatch ────────────────────────────────────────────────────────────

    /// Resolve a renderer action and run it: in the hosted module that owns
    /// it, or else through the closure dispatcher. See
    /// `Engine::dispatch_action`; callers skip this when
    /// [`is_empty`](Self::is_empty).
    pub(crate) fn dispatch_ui_action(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        action: Action,
    ) -> Result<(), EngineError> {
        // A bare name several hosted modules export would be refused by
        // `route_ui_action` as ambiguous anyway; refuse it here with a message
        // that names the owners.
        if action.name != UI_ACTION && split_scoped_action(&action.name).is_none() {
            let owners: Vec<&str> = self
                .registry
                .exporters_of(&action.name)
                .map(ScopeName::as_str)
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
        let action = ctx.core.route_ui_action(action)?;
        // The scope of a routed scoped name is canonical already.
        let hit = split_scoped_action(&action.name).and_then(|(scope, name)| {
            let (scope, module) = self.registry.resolve(scope)?;
            module
                .actions
                .accepts(name)
                .then(|| (scope.clone(), name.to_string()))
        });
        match hit {
            Some((scope, name)) => {
                let action = HostAction::new(name, encode_payload(action.payload));
                self.run_cascade(ctx, scope, Call::Dispatch(action))
            }
            None => ctx.closures.dispatch(&action),
        }
    }

    /// Run an action that `EngineCore::route_client_action` already
    /// resolved: in the hosted module that owns the scoped name, or else
    /// through the closure dispatcher. No routing happens here — see
    /// `Engine::dispatch_client_action`.
    pub(crate) fn dispatch_routed(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        action: Action,
    ) -> Result<(), EngineError> {
        let hit = split_scoped_action(&action.name).and_then(|(scope, name)| {
            let (scope, module) = self.registry.resolve(scope)?;
            module
                .actions
                .accepts(name)
                .then(|| (scope.clone(), name.to_string()))
        });
        match hit {
            Some((scope, name)) => {
                let action = HostAction::new(name, encode_payload(action.payload));
                self.run_cascade(ctx, scope, Call::Dispatch(action))
            }
            None => ctx.closures.dispatch(&action),
        }
    }

    /// Run `name` in the module wired under `scope`, skipping renderer
    /// routing. See `Engine::dispatch_module_action`.
    pub(crate) fn dispatch_trusted(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &str,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        let Some((scope, module)) = self.registry.resolve(scope) else {
            return Err(EngineError::ActionNotFound(format!(
                "no hosted module under scope '{}'",
                canonical_scope(scope)
            )));
        };
        if !module.actions.accepts(name) {
            return Err(EngineError::ActionNotFound(format!(
                "module '{scope}' does not accept action '{name}'"
            )));
        }
        let scope = scope.clone();
        let action = HostAction::new(name, encode_payload(Some(payload)));
        self.run_cascade(ctx, scope, Call::Dispatch(action))
    }

    /// Drive a lifecycle export of `scope` and fold its output like a
    /// dispatch. No-op when `scope` has no wired instance.
    pub(crate) fn run_lifecycle(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &str,
        hook: LifecycleHook,
    ) -> Result<(), EngineError> {
        let Some((scope, _)) = self.registry.resolve(scope) else {
            return Ok(());
        };
        let scope = scope.clone();
        self.run_cascade(ctx, scope, Call::Lifecycle(hook))
    }

    // ── host state writes ───────────────────────────────────────────────────

    /// Decide, *before* a host write to `scope` is applied, which subscribers
    /// it will have to notify. `collect` pushes the paths at which the write
    /// changes the scope's current state; they are matched exactly as a
    /// reducer's changes are.
    ///
    /// `None` (and no path work at all) when there are no subscriptions, the
    /// write targets the primary slot (never a subscription target), nothing
    /// watches `scope`, or a cascade is draining: a write applied while a
    /// reducer output is being folded is notified by that fold.
    pub(crate) fn host_write_notice(
        &self,
        core: &EngineCore,
        scope: Option<&str>,
        collect: impl FnOnce(&serde_json::Value, &mut Vec<String>),
    ) -> Option<HostWriteNotice> {
        if self.subscriptions.is_empty() || self.cascade_state == CascadeState::Draining {
            return None;
        }
        let scope = canonical_scope(scope.filter(|s| !s.is_empty())?);
        if !self.subscriptions.has_watchers(&scope) {
            return None;
        }
        let state = core.get_module_state(&scope)?;
        let mut changed = Vec::new();
        collect(state, &mut changed);
        if changed.is_empty() {
            return None;
        }
        let notifications = self.subscriptions.notifications_for(&scope, &changed);
        (!notifications.is_empty()).then(|| HostWriteNotice {
            scope: scope.into_owned(),
            notifications,
        })
    }

    /// Run the notifications of an applied host write as one cascade (the
    /// write is its depth-1 root). The write itself always stands.
    pub(crate) fn notify_host_write(&mut self, ctx: &mut EngineCtx<'_>, notice: HostWriteNotice) {
        if self.cascade_state == CascadeState::Draining {
            return;
        }
        self.cascade_state = CascadeState::Draining;
        let HostWriteNotice {
            scope,
            notifications,
        } = notice;
        let mut cascade = Cascade::new(CascadeRoot::HostWrite { scope }, self.dispatch_budget);
        self.admit_notifications(&mut cascade, notifications, 1);
        let report = self.drain_queue(ctx, cascade);
        self.cascade_state = CascadeState::Idle;
        // The host-facing update APIs return nothing, so the failures cannot
        // be returned: `conclude` logs each one and keeps the report for
        // `last_report`.
        let _ = self.conclude(report);
    }
}

/// The validated names a module instance is wired with.
struct WiringNames {
    scope: ScopeName,
    actions: ActionSet,
}

impl WiringNames {
    /// The one place caller-supplied scope and action names are validated;
    /// nothing is changed when this fails.
    fn parse(scope: &str, actions: Vec<String>) -> Result<Self, EngineError> {
        let invalid = |e: InvalidName| EngineError::ModuleError(e.to_string());
        let scope = ScopeName::parse(scope).map_err(invalid)?;
        let actions = ActionSet::parse(&scope, actions).map_err(invalid)?;
        Ok(Self { scope, actions })
    }
}

/// JSON-encode an action payload for a module's `dispatch` export. No payload
/// is `null`.
fn encode_payload(payload: Option<serde_json::Value>) -> Vec<u8> {
    payload
        // Serializing a `serde_json::Value` cannot fail (its map keys are
        // strings); `null` stands in rather than panicking if it ever did.
        .and_then(|value| serde_json::to_vec(&value).ok())
        .unwrap_or_else(|| b"null".to_vec())
}
