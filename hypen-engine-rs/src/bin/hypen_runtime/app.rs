//! The [`Runtime`]: the one object that owns the engine, the hosted modules
//! and everything rendered from them.
//!
//! ## Ownership and locking
//!
//! All mutable state lives behind `Runtime`:
//!
//! - `core` — the engine, the table of hosted module instances and the UI
//!   sources' bookkeeping, behind **the engine lock**. Every engine call
//!   (dispatch, timer fire, hot reload, crash recovery) happens inside a
//!   `Runtime` method holding it, so they are serialised.
//! - `hub`, `outbox`, the UI source map — leaf state the engine's callbacks
//!   write to *while the engine lock is held* (the engine calls them
//!   re-entrantly, so they cannot live inside `core`). Each has its own small
//!   lock, taken only for single operations and never while taking another.
//!
//! Lock order is therefore always engine lock → one leaf lock.
//!
//! ## Crashed modules
//!
//! A module instance that traps or exceeds its call deadline is dead: the
//! host answers every later call with `HostError::DeadInstance`. Policy:
//!
//! 1. The dispatch that killed it fails with [`RuntimeError::ModuleCrashed`]
//!    naming the scope(s) and what the host says killed each. Detection
//!    makes no guest call and reads no message text: after a failed dispatch
//!    the host is asked for each instance's
//!    [`InstanceStatus`](hypen_engine::module_host::InstanceStatus) — its own
//!    bookkeeping. A host that does not track health answers `Unknown`; for
//!    those the engine's structured cascade report of that same dispatch is
//!    consulted instead (a failure whose cause is the host's typed
//!    `Trap` / `DeadInstance`).
//! 2. The **next action** (any dispatch or timer) first re-instantiates each
//!    crashed module from its registered component and re-runs `init` with
//!    its original config. The crashed instance's state is lost; this is
//!    logged loudly. If the restart itself fails the module stays crashed and
//!    is retried on the following action.
//!
//! A `.wasm` hot reload of a crashed module restarts it the same way, from
//! the new bytes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use hypen_engine::dispatch::Action;
use hypen_engine::ir::ResolvedComponent;
use hypen_engine::module_host::{
    ComponentCompiler, DualHost, Effect, HostConfig, HostError, InstanceStatus, ModuleHost,
    ModuleInstanceId, ModuleManifest,
};
use hypen_engine::hosted::FailureCause;
use hypen_engine::{Engine, EngineError, ModuleGrants, Patch};
use serde_json::{json, Map, Value};

use crate::cli::{ActionSource, ModuleSource, Options, Source};
use crate::effects::{EffectOutbox, HostEffects};
use crate::error::{GrantSurface, ModuleStage, RuntimeError};
use crate::manifest::{AppManifest, ModuleKind};
use crate::patches::{PatchHub, Subscription, TooManySubscribers};
use crate::sync::lock;
use crate::template;
use crate::usage_plan::{self, PlanModule, PlannedInstance};

/// The engine's reserved UI-envelope action: `{ node, action, payload }`,
/// resolved to a scope by node ownership.
const UI_ENVELOPE_ACTION: &str = "__hypen_dispatch";

// ── dispatch requests ───────────────────────────────────────────────────────

/// How an action name addresses its handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionTarget {
    /// A bare (or engine-reserved) name, resolved by the engine's UI routing
    /// rules.
    Named,
    /// `scope:action` — the operator addressing a hosted module directly.
    /// This is the trusted path (`Engine::dispatch_module_action`), offered
    /// only on the REPL and the origin-checked dev endpoint.
    Scoped { scope: String, action: String },
}

/// An action arriving from the REPL or `POST /dispatch`.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchRequest {
    /// The action name as given.
    pub name: String,
    pub target: ActionTarget,
    pub payload: Value,
    /// Patch-wire node id of the element that fired the action, if a UI
    /// client supplied one: the engine then resolves the owning scope from
    /// the node.
    pub sender: Option<String>,
}

impl DispatchRequest {
    pub fn new(name: &str, payload: Value, sender: Option<String>) -> Self {
        let target = match name.split_once(':') {
            // `__hypen_scoped:<scope>:<action>` and friends are engine wire
            // names, not operator qualifiers.
            Some((scope, action)) if !scope.is_empty() && !name.starts_with("__hypen_") => {
                ActionTarget::Scoped { scope: scope.to_lowercase(), action: action.to_string() }
            }
            _ => ActionTarget::Named,
        };
        DispatchRequest { name: name.to_string(), target, payload, sender }
    }

    /// The scope the operator explicitly addressed, if any.
    pub fn addressed_scope(&self) -> Option<&str> {
        match &self.target {
            ActionTarget::Scoped { scope, .. } => Some(scope),
            ActionTarget::Named => None,
        }
    }
}

/// Module state as reported to clients.
#[derive(Debug, Clone, PartialEq)]
pub struct StateView {
    /// The entry scope's state (`null` when the entry is stateless).
    pub entry: Value,
    /// Every module scope → its state.
    pub scopes: Map<String, Value>,
}

/// Everything one dispatch produced, attributed under the engine lock.
pub struct DispatchOutcome {
    pub result: Result<(), RuntimeError>,
    /// Exactly the patches rendered by this dispatch (never an out-of-band
    /// render's).
    pub patches: Vec<Patch>,
    pub effects: HostEffects,
    pub state: StateView,
}

// ── hosted modules ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Health {
    Running,
    /// The instance is dead; restart on the next action.
    Crashed,
}

/// What it takes to bring up one module instance.
#[derive(Clone)]
pub(crate) struct InstanceSpec {
    pub scope: String,
    /// Where this instance's grants are written, for hints: the app.json
    /// module entry backing it, or the scope itself in single-module mode.
    pub entry: String,
    pub wasm: PathBuf,
    pub manifest: ModuleManifest,
    /// The config passed to `init`.
    pub config: Value,
    pub actions: ActionSource,
}

/// A live hosted module instance and what is needed to reload or restart it.
pub(crate) struct HostedModule {
    pub spec: InstanceSpec,
    /// The action names currently routed to the instance.
    pub actions: Vec<String>,
    pub health: Health,
    /// What the host said killed the instance, while `health` is `Crashed`.
    pub crash_reason: Option<String>,
}

impl HostedModule {
    /// Whether the instance is routed `action` (a `"*"` entry takes any name).
    fn handles(&self, action: &str) -> bool {
        self.actions.iter().any(|a| a == action || a == "*")
    }
}

/// Which of the three addressing forms produced a dispatch's result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoutedBy {
    /// The sender node resolved the owning scope.
    Sender,
    /// `scope:action`, to a hosted scope.
    Scope,
    /// The name as given, resolved by the engine's bare-name rules.
    Name,
}

/// How long a component registration may take before the runtime says so
/// (and, without a compilation cache, how to avoid it next time).
const SLOW_REGISTER: Duration = Duration::from_secs(5);

/// Most candidate `scope:action` forms listed in an error.
const MAX_CANDIDATES: usize = 12;

/// A module whose instance is dead, and what the host said killed it.
struct Crash {
    scope: String,
    reason: Option<String>,
}

/// A started (instantiated + initialised) instance not yet wired to the
/// engine.
struct Started {
    id: ModuleInstanceId,
    state: Value,
    actions: Vec<String>,
}

// ── UI sources ──────────────────────────────────────────────────────────────

/// Template source by component name, as the engine should see it. Shared
/// between the component resolver (reads on every render) and hot reload
/// (rewrites on change).
#[derive(Default)]
pub(crate) struct UiSources {
    by_name: Mutex<HashMap<String, String>>,
}

impl UiSources {
    fn new(sources: HashMap<String, String>) -> Self {
        UiSources { by_name: Mutex::new(sources) }
    }

    pub fn get(&self, name: &str) -> Option<String> {
        lock(&self.by_name, "ui sources").get(name).cloned()
    }

    pub fn set(&self, name: &str, source: String) {
        lock(&self.by_name, "ui sources").insert(name.to_string(), source);
    }

    pub fn replace(&self, sources: HashMap<String, String>) {
        *lock(&self.by_name, "ui sources") = sources;
    }
}

/// A watched `.hypen` file and the component name it provides.
pub(crate) struct UiFile {
    pub name: String,
    pub path: PathBuf,
}

/// The declarative UI being rendered.
pub(crate) struct Ui {
    /// Component name of the entry template (its key in `sources`).
    pub entry: String,
    pub files: Vec<UiFile>,
    pub sources: Arc<UiSources>,
    /// `--app` only: what a template edit needs to re-plan per-usage
    /// instances.
    pub app: Option<AppUi>,
}

pub(crate) struct AppUi {
    pub manifest: AppManifest,
    /// Pristine template sources by component name. `Ui::sources` holds the
    /// *rewritten* ones; a re-plan always starts from these.
    pub raw: HashMap<String, String>,
}

// ── the core (behind the engine lock) ───────────────────────────────────────

pub(crate) struct Core {
    pub engine: Engine,
    pub modules: Vec<HostedModule>,
    pub ui: Option<Ui>,
    /// Where grants come from, for capability hints.
    pub surface: GrantSurface,
    /// Whether compiled components persist across runs (`--cache-dir`), for
    /// the slow-compilation notice.
    pub disk_cache: bool,
}

impl Core {
    fn host(&mut self) -> Result<&mut (dyn ModuleHost + 'static), RuntimeError> {
        self.engine
            .module_host_mut()
            .ok_or(RuntimeError::Internal("no module host installed"))
    }

    /// A host failure while bringing `spec`'s module up. For a refused
    /// instantiation the host is asked which capabilities it denied, so the
    /// hint can name the exact grants.
    pub fn module_error(
        &mut self,
        spec: &InstanceSpec,
        stage: ModuleStage,
        source: HostError,
    ) -> RuntimeError {
        let denied = match (stage, self.engine.module_host_mut()) {
            (ModuleStage::Instantiate, Some(host)) => host.denied_capabilities(&spec.scope),
            _ => Vec::new(),
        };
        RuntimeError::Module {
            scope: spec.scope.clone(),
            stage,
            surface: self.surface,
            entry: spec.entry.clone(),
            denied,
            source,
        }
    }

    /// (Re-)register a module's component from `bytes` (the contents of its
    /// `.wasm`). Compilation happens here unless the host already holds the
    /// same bytes compiled (another scope of the same file, or a precompile).
    pub fn register_bytes(&mut self, spec: &InstanceSpec, bytes: &[u8]) -> Result<(), RuntimeError> {
        let manifest = spec.manifest.clone();
        let started = Instant::now();
        let registered = self.host()?.register(&spec.scope, bytes, manifest);
        let took = started.elapsed();
        if registered.is_ok() && took >= SLOW_REGISTER {
            eprintln!(
                "[modules] preparing `{}` ({}) took {:.1} s{}",
                spec.scope,
                spec.wasm.display(),
                took.as_secs_f64(),
                if self.disk_cache {
                    ""
                } else {
                    "; pass --cache-dir DIR to keep compiled modules across runs"
                },
            );
        }
        registered.map_err(|e| self.module_error(spec, ModuleStage::Register, e))
    }

    /// (Re-)register a module's component bytes from its `.wasm` file.
    pub fn register_component(&mut self, spec: &InstanceSpec) -> Result<(), RuntimeError> {
        let bytes = std::fs::read(&spec.wasm)
            .map_err(|e| RuntimeError::io("read", &spec.wasm, e))?;
        self.register_bytes(spec, &bytes)
    }

    /// Instantiate `scope`'s registered component and run `init`. If anything
    /// after `instantiate` fails, the half-started instance is destroyed
    /// rather than leaked.
    fn start_instance(&mut self, spec: &InstanceSpec) -> Result<Started, RuntimeError> {
        let scope = spec.scope.as_str();
        let id = match self.host()?.instantiate(scope) {
            Ok(id) => id,
            Err(e) => return Err(self.module_error(spec, ModuleStage::Instantiate, e)),
        };

        let started = self.init_instance(spec, id);
        if started.is_err() {
            // Best effort: the instance may already be dead (init trapped).
            if let Ok(host) = self.host() {
                let _ = host.destroy(id);
            }
        }
        started
    }

    /// Run `init` on a fresh instance and learn its actions.
    fn init_instance(
        &mut self,
        spec: &InstanceSpec,
        id: ModuleInstanceId,
    ) -> Result<Started, RuntimeError> {
        let scope = spec.scope.as_str();
        let config = serde_json::to_vec(&spec.config)
            .map_err(|source| RuntimeError::InitState { scope: scope.to_string(), source })?;
        let state_bytes = match self.host()?.init(id, &config) {
            Ok(bytes) => bytes,
            Err(e) => return Err(self.module_error(spec, ModuleStage::Init, e)),
        };
        let state: Value = serde_json::from_slice(&state_bytes)
            .map_err(|source| RuntimeError::InitState { scope: scope.to_string(), source })?;
        let actions = match &spec.actions {
            ActionSource::Override(list) => list.clone(),
            ActionSource::Discover => match self.host()?.actions(id) {
                Ok(actions) => actions,
                Err(e) => return Err(self.module_error(spec, ModuleStage::QueryActions, e)),
            },
        };
        Ok(Started { id, state, actions })
    }

    /// Start an instance and wire it into the engine under its scope,
    /// replacing whatever was wired there. On failure nothing stays behind in
    /// the host.
    fn start_and_wire(&mut self, spec: &InstanceSpec) -> Result<Vec<String>, RuntimeError> {
        let started = self.start_instance(spec)?;
        let grants = ModuleGrants::from(&spec.manifest);
        if let Err(source) = self.engine.register_module_instance(
            &spec.scope,
            started.id,
            started.actions.clone(),
            grants,
            started.state,
        ) {
            if let Ok(host) = self.host() {
                let _ = host.destroy(started.id);
            }
            return Err(RuntimeError::Engine {
                scope: spec.scope.clone(),
                context: "cannot wire the module into the engine",
                source,
            });
        }
        Ok(started.actions)
    }

    /// Register, instantiate, init and wire one new module instance.
    ///
    /// With `HYPEN_RUNTIME_TIMINGS` set in the environment, logs how long
    /// each half took (registering is where a component is compiled or
    /// loaded from the cache; starting is instantiate + `init`).
    pub fn mint(&mut self, spec: InstanceSpec) -> Result<(), RuntimeError> {
        let started = Instant::now();
        self.register_component(&spec)?;
        let registered = started.elapsed();
        let actions = self.start_and_wire(&spec)?;
        if std::env::var_os("HYPEN_RUNTIME_TIMINGS").is_some() {
            eprintln!(
                "[timings] `{}`: register {:.1} ms, instantiate + init {:.1} ms",
                spec.scope,
                registered.as_secs_f64() * 1e3,
                (started.elapsed() - registered).as_secs_f64() * 1e3,
            );
        }
        self.modules.push(HostedModule {
            spec,
            actions,
            health: Health::Running,
            crash_reason: None,
        });
        Ok(())
    }

    /// Run a module's `on_activated`; a failure is logged, not fatal.
    pub fn activate(&mut self, scope: &str) {
        if let Err(e) = self.engine.activate_module(scope) {
            eprintln!("[runtime] on_activated({scope}) failed: {e}");
        }
    }

    /// Re-parse the entry template from the current sources and reconcile it
    /// against the live tree. No-op without a UI.
    pub fn render_entry(&mut self) -> Result<(), RuntimeError> {
        let Some(ui) = &self.ui else {
            return Ok(());
        };
        let source = ui
            .sources
            .get(&ui.entry)
            .ok_or(RuntimeError::Internal("entry template missing from ui sources"))?;
        let ir = template::entry_ir(&source, &ui.entry)?;
        // Drop cached component expansions so referenced modules pick up
        // their current source.
        self.engine.clear_resolved_components();
        self.engine.render_ir_node(&ir);
        Ok(())
    }

    /// Restart one module from scratch (fresh instance, `init` with the
    /// original config), replacing its engine state. Used for crash recovery.
    pub fn restart(&mut self, index: usize) -> Result<(), RuntimeError> {
        let Some(module) = self.modules.get(index) else {
            return Err(RuntimeError::Internal("restart of an unknown module"));
        };
        let spec = module.spec.clone();
        let scope = spec.scope.clone();
        let old_id = self.engine.module_instance_id(&scope);
        let actions = self.start_and_wire(&spec)?;
        if let Some(module) = self.modules.get_mut(index) {
            module.actions = actions;
            module.health = Health::Running;
            module.crash_reason = None;
        }
        if let Some(old) = old_id {
            if let Ok(host) = self.host() {
                // Frees the dead instance's slot; it may already be gone.
                let _ = host.destroy(old);
            }
        }
        self.activate(&scope);
        Ok(())
    }

    /// Restart every crashed module. Returns the ones that are *still*
    /// crashed because their restart failed.
    fn revive_crashed(&mut self) -> Vec<Crash> {
        let mut revived = false;
        let mut still_crashed = Vec::new();
        for index in 0..self.modules.len() {
            let Some(module) = self.modules.get(index) else {
                break;
            };
            if module.health != Health::Crashed {
                continue;
            }
            let scope = module.spec.scope.clone();
            let reason = module.crash_reason.clone();
            match self.restart(index) {
                Ok(()) => {
                    eprintln!(
                        "[crash] module `{scope}` was RESTARTED from its initial config — \
                         the state it held before crashing is lost"
                    );
                    revived = true;
                }
                Err(e) => {
                    eprintln!(
                        "[crash] module `{scope}` could not be restarted (will retry on the \
                         next action): {}",
                        crate::error::one_line(&e)
                    );
                    still_crashed.push(Crash { scope, reason });
                }
            }
        }
        if revived {
            // Show the re-initialised state in the UI.
            if let Err(e) = self.render_entry() {
                eprintln!("[crash] re-render after restart failed: {e}");
            }
        }
        still_crashed
    }

    /// Find the running instances a failed dispatch left dead; mark and
    /// return them. `failure` is that dispatch's error.
    ///
    /// The host's [`InstanceStatus`] is authoritative and costs no guest
    /// call. Only for a host that answers `Unknown` is the engine's cascade
    /// report consulted — and only if it is the report *of this failure*
    /// (it renders to the same error), since a dispatch refused before any
    /// module ran leaves the previous cascade's report in place.
    fn detect_crashes(&mut self, failure: &EngineError) -> Vec<Crash> {
        let mut crashed = Vec::new();
        for index in 0..self.modules.len() {
            let Some(module) = self.modules.get(index) else {
                break;
            };
            if module.health != Health::Running {
                continue;
            }
            let scope = module.spec.scope.clone();
            let Some(id) = self.engine.module_instance_id(&scope) else {
                continue;
            };
            let status = match self.engine.module_host_mut() {
                Some(host) => host.instance_status(id),
                None => InstanceStatus::Unknown,
            };
            let reason = match status {
                InstanceStatus::Live => continue,
                InstanceStatus::Dead { reason } => reason,
                InstanceStatus::Gone => {
                    Some("the module host no longer has this instance".to_string())
                }
                // `InstanceStatus` is non-exhaustive: a status this runtime
                // does not know is treated like `Unknown`.
                _ => match self.reported_death(&scope, failure) {
                    Some(reason) => Some(reason),
                    None => continue,
                },
            };
            if let Some(module) = self.modules.get_mut(index) {
                module.health = Health::Crashed;
                module.crash_reason = reason.clone();
            }
            crashed.push(Crash { scope, reason });
        }
        crashed
    }

    /// The host error that killed `scope`'s instance according to the
    /// engine's structured report of the cascade that produced `failure`.
    fn reported_death(&self, scope: &str, failure: &EngineError) -> Option<String> {
        let report = self.engine.last_module_cascade_report()?;
        if report.to_engine_error() != *failure {
            return None;
        }
        report.failures().iter().find_map(|f| match &f.cause {
            FailureCause::Host(e @ (HostError::Trap(_) | HostError::DeadInstance))
                if f.scope == scope =>
            {
                Some(e.to_string())
            }
            _ => None,
        })
    }

    /// Route one request to the engine (see [`ActionTarget`]), reporting
    /// which addressing form its result came from.
    fn route(&mut self, request: &DispatchRequest) -> (RoutedBy, Result<(), EngineError>) {
        if let Some(node) = &request.sender {
            let envelope = json!({
                "node": node,
                "action": request.name,
                "payload": request.payload,
            });
            let action = Action::new(UI_ENVELOPE_ACTION).with_payload(envelope);
            match self.engine.dispatch_action(action) {
                // The node is not owned by a scope that handles the action:
                // fall back to the sender-less forms below.
                Err(EngineError::ActionNotFound(_)) => {}
                other => return (RoutedBy::Sender, other),
            }
        }
        if let ActionTarget::Scoped { scope, action } = &request.target {
            if self.engine.module_instance_id(scope).is_some() {
                let result =
                    self.engine.dispatch_module_action(scope, action, request.payload.clone());
                return (RoutedBy::Scope, result);
            }
        }
        let action = Action::new(request.name.as_str()).with_payload(request.payload.clone());
        (RoutedBy::Name, self.engine.dispatch_action(action))
    }

    /// The `scope:action` forms of every hosted module that handles `action`.
    fn handlers_of(&self, action: &str) -> Vec<String> {
        self.modules
            .iter()
            .filter(|m| m.handles(action))
            .map(|m| format!("{}:{action}", m.spec.scope))
            .collect()
    }

    /// What to suggest for a request no module handled: the same action in
    /// the scopes that do export it, else the addressed scope's own actions,
    /// else everything there is. Capped at [`MAX_CANDIDATES`].
    fn candidates_for(&self, request: &DispatchRequest) -> Vec<String> {
        let (scope, action) = match &request.target {
            ActionTarget::Scoped { scope, action } => (Some(scope.as_str()), action.as_str()),
            ActionTarget::Named => (None, request.name.as_str()),
        };
        let mut candidates = self.handlers_of(action);
        // Never suggest the very form that just failed.
        candidates.retain(|c| Some(c.as_str()) != scope.map(|s| format!("{s}:{action}")).as_deref());
        if candidates.is_empty() {
            candidates = self
                .modules
                .iter()
                .filter(|m| scope.is_none_or(|s| m.spec.scope == s))
                .flat_map(|m| {
                    m.actions.iter().filter(|a| *a != "*").map(|a| format!("{}:{a}", m.spec.scope))
                })
                .collect();
        }
        candidates.truncate(MAX_CANDIDATES);
        candidates
    }

    /// Turn an engine dispatch result into the runtime's: a crash, an
    /// ambiguous or unknown action, or the engine's own error.
    ///
    /// `still_crashed` are modules whose restart just failed — a module
    /// failure with those around is reported as a crash too.
    fn classify(
        &mut self,
        request: Option<&DispatchRequest>,
        routed: (RoutedBy, Result<(), EngineError>),
        mut still_crashed: Vec<Crash>,
    ) -> Result<(), RuntimeError> {
        let (routed_by, result) = routed;
        let source = match result {
            Ok(()) => return Ok(()),
            Err(source) => source,
        };

        // A bare name is refused by the engine when several modules export
        // it — as `ModuleError` by the hosted pre-check or `ActionNotFound`
        // by the core's routing, depending on how they are wired. Either way
        // no module ran. The runtime's own module table says who the
        // candidates are.
        let bare = request.filter(|r| {
            routed_by == RoutedBy::Name
                && r.target == ActionTarget::Named
                && !r.name.starts_with("__hypen_")
        });
        if let Some(request) = bare {
            let candidates = self.handlers_of(&request.name);
            if candidates.len() > 1
                && matches!(source, EngineError::ModuleError(_) | EngineError::ActionNotFound(_))
            {
                return Err(RuntimeError::AmbiguousAction {
                    action: request.name.clone(),
                    candidates,
                });
            }
        }

        match source {
            source @ EngineError::ModuleError(_) => {
                let newly = self.detect_crashes(&source);
                for crash in &newly {
                    eprintln!(
                        "[crash] module `{}` CRASHED ({}). Its state is lost; it will be \
                         re-instantiated and re-initialised on the next action.",
                        crash.scope,
                        crash.reason.as_deref().unwrap_or("the host gave no reason"),
                    );
                }
                still_crashed.extend(newly);
                if still_crashed.is_empty() {
                    return Err(RuntimeError::Dispatch(source));
                }
                let reasons = still_crashed
                    .iter()
                    .filter_map(|c| c.reason.as_ref().map(|r| (still_crashed.len(), &c.scope, r)))
                    .map(|(n, scope, reason)| {
                        // The host's reason already names the module; add the
                        // scope only when several are listed.
                        if n > 1 {
                            format!("`{scope}`: {reason}")
                        } else {
                            reason.clone()
                        }
                    })
                    .collect();
                let scopes = still_crashed.into_iter().map(|c| c.scope).collect();
                Err(RuntimeError::ModuleCrashed { scopes, reasons, source })
            }
            source @ EngineError::ActionNotFound(_) => match request {
                Some(request) if !request.name.starts_with("__hypen_") => {
                    Err(RuntimeError::UnknownAction {
                        name: request.name.clone(),
                        candidates: self.candidates_for(request),
                        engine: source,
                    })
                }
                _ => Err(RuntimeError::Dispatch(source)),
            },
            other => Err(RuntimeError::Dispatch(other)),
        }
    }

    fn state_view(&self, entry_scope: &str) -> StateView {
        StateView {
            entry: self.engine.get_module_state(entry_scope).cloned().unwrap_or(Value::Null),
            scopes: self
                .engine
                .modules()
                .iter()
                .map(|(name, instance)| (name.clone(), instance.get_state().clone()))
                .collect(),
        }
    }

    /// The action names clients can dispatch: a lone module's list as it
    /// declared it, otherwise the sorted union across modules.
    fn action_names(&self) -> Vec<String> {
        match self.modules.as_slice() {
            [only] => only.actions.clone(),
            modules => {
                let mut all: Vec<String> =
                    modules.iter().flat_map(|m| m.actions.iter().cloned()).collect();
                all.sort();
                all.dedup();
                all
            }
        }
    }
}

// ── the runtime ─────────────────────────────────────────────────────────────

/// See the module docs.
pub struct Runtime {
    /// Compiles components without the engine lock (hot reload). `None` on
    /// hosts that have no such handle (the unit tests' fake).
    compiler: Option<ComponentCompiler>,
    core: Mutex<Core>,
    hub: Arc<PatchHub>,
    outbox: Arc<EffectOutbox>,
    entry_scope: String,
}

/// A booted runtime plus what its boot rendered.
pub struct Booted {
    pub runtime: Runtime,
    /// The initial render (and anything `on_activated` re-rendered), for the
    /// REPL to print. `None` when there is no declarative UI.
    pub initial_patches: Option<Vec<Patch>>,
}

impl Runtime {
    /// Boot what `options` describes on the real wasmtime host.
    pub fn boot(options: &Options) -> Result<Booted, RuntimeError> {
        let mut config = HostConfig::default();
        if let Some(max_call) = options.call_timeout {
            config.limits.max_call = max_call;
        }
        config.data_dir = options.data_dir.clone();
        config.cache_dir = options.cache_dir.clone();
        // Dual-ABI host: v0.1 sync and v0.2 CM-async components both boot
        // here; `register` sniffs which world the bytes target.
        let host = DualHost::with_config(&config)
            .map_err(|source| RuntimeError::HostStart { source })?;
        let compiler = host.compiler();
        Self::boot_on(&options.source, Box::new(host), Some(compiler), options.cache_dir.is_some())
    }

    /// Boot on any [`ModuleHost`] (tests use a fake one).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn boot_with_host(
        source: &Source,
        host: Box<dyn ModuleHost>,
    ) -> Result<Booted, RuntimeError> {
        Self::boot_on(source, host, None, false)
    }

    fn boot_on(
        source: &Source,
        host: Box<dyn ModuleHost>,
        compiler: Option<ComponentCompiler>,
        disk_cache: bool,
    ) -> Result<Booted, RuntimeError> {
        let hub = Arc::new(PatchHub::new());
        let outbox = Arc::new(EffectOutbox::default());

        let mut engine = Engine::new();
        engine.set_module_host(host);
        let render_hub = Arc::clone(&hub);
        engine.set_render_callback(move |patches: &[Patch]| render_hub.publish(patches));
        let effect_outbox = Arc::clone(&outbox);
        engine.set_effect_handler(move |scope: &str, effect: &Effect| {
            effect_outbox.push(scope, effect);
        });

        let surface = match source {
            Source::Module(_) => GrantSurface::CommandLine,
            Source::App { .. } => GrantSurface::AppManifest,
        };
        let mut core = Core { engine, modules: Vec::new(), ui: None, surface, disk_cache };
        let entry_scope = match source {
            Source::Module(module) => boot_module(&mut core, module)?,
            Source::App { manifest } => boot_app(&mut core, manifest)?,
        };

        // Initial render, then wake every instance now that the render sink
        // and effect outbox are in place — so an `on_activated` that
        // subscribes to a sibling, emits effects or mutates state has its
        // output folded, not dropped.
        let capture = hub.capture();
        core.render_entry()?;
        let scopes: Vec<String> = core.modules.iter().map(|m| m.spec.scope.clone()).collect();
        for scope in &scopes {
            core.activate(scope);
        }
        let initial = capture.finish();
        let initial_patches = core.ui.is_some().then_some(initial);

        let runtime = Runtime { compiler, core: Mutex::new(core), hub, outbox, entry_scope };
        Ok(Booted { runtime, initial_patches })
    }

    /// The handle hot reload compiles with, outside the engine lock.
    pub(crate) fn compiler(&self) -> Option<&ComponentCompiler> {
        self.compiler.as_ref()
    }

    pub(crate) fn core(&self) -> MutexGuard<'_, Core> {
        lock(&self.core, "engine")
    }

    /// The scope reported as "the" module: the single module's, or the app's
    /// entry.
    pub fn entry_scope(&self) -> &str {
        &self.entry_scope
    }

    /// Dispatch one request. Restarts crashed modules first; the patches this
    /// dispatch renders are captured for the caller and *not* broadcast.
    pub fn dispatch(&self, request: &DispatchRequest) -> DispatchOutcome {
        let mut core = self.core();
        let capture = self.hub.capture();
        let still_crashed = core.revive_crashed();
        let routed = core.route(request);
        let result = core.classify(Some(request), routed, still_crashed);
        let patches = capture.finish();
        let effects = self.outbox.drain();
        let state = core.state_view(&self.entry_scope);
        DispatchOutcome { result, patches, effects, state }
    }

    /// Fire a due timer: dispatch `action` to `scope` through the trusted
    /// module path. Its render is out-of-band — broadcast to SSE subscribers.
    /// Returns the effects the delayed dispatch emitted in turn.
    pub fn fire_timer(&self, scope: &str, action: &str) -> HostEffects {
        let mut core = self.core();
        if !core.modules.iter().any(|m| m.spec.scope == scope) {
            // Scheduled by a usage scope a template edit has since retired.
            eprintln!("[timers] dropped {scope}:{action}: scope `{scope}` no longer exists");
            return self.outbox.drain();
        }
        let still_crashed = core.revive_crashed();
        let fired = core.engine.dispatch_module_action(scope, action, Value::Null);
        if let Err(e) = core.classify(None, (RoutedBy::Scope, fired), still_crashed) {
            eprintln!("[timers] {scope}:{action} failed: {}", crate::error::one_line(&e));
        }
        self.outbox.drain()
    }

    pub fn module_state(&self, scope: &str) -> Value {
        self.core().engine.get_module_state(scope).cloned().unwrap_or(Value::Null)
    }

    /// The `GET /state` body: `{ scope, actions, state, states }`.
    pub fn state_envelope(&self) -> Value {
        let core = self.core();
        let view = core.state_view(&self.entry_scope);
        json!({
            "scope": self.entry_scope,
            "actions": core.action_names(),
            "state": view.entry,
            "states": view.scopes,
        })
    }

    /// The patches that rebuild the current rendered tree (`GET /patches`).
    /// Taken under the engine lock so it never observes half a render.
    pub fn tree_snapshot(&self) -> Vec<Patch> {
        let _core = self.core();
        self.hub.snapshot()
    }

    /// Subscribe to out-of-band renders (`GET /events`).
    pub fn subscribe(&self) -> Result<Subscription, TooManySubscribers> {
        self.hub.subscribe()
    }
}

/// Single-module mode: host one `.wasm`, optionally rendering a `--ui`
/// template against its state. Returns the entry scope.
fn boot_module(core: &mut Core, module: &ModuleSource) -> Result<String, RuntimeError> {
    let scope = module.scope.as_str().to_string();

    // Parse the optional declarative UI *before* init so a `module X(args)`
    // root can seed the module's `init(config)`.
    let mut config = template::Config::new();
    let mut ui = None;
    if let Some(path) = &module.ui {
        let source =
            std::fs::read_to_string(path).map_err(|e| RuntimeError::io("read", path, e))?;
        let root = template::first_component(&source, &path.display().to_string())?;
        config = template::declaration_config(&root);
        ui = Some(Ui {
            entry: scope.clone(),
            files: vec![UiFile { name: scope.clone(), path: canonical(path) }],
            sources: Arc::new(UiSources::new(HashMap::from([(scope.clone(), source)]))),
            app: None,
        });
    }

    core.mint(InstanceSpec {
        scope: scope.clone(),
        entry: scope.clone(),
        wasm: canonical(&module.wasm),
        manifest: module.grants.to_manifest(&module.scope),
        config: Value::Object(config),
        actions: module.actions.clone(),
    })?;
    if module.actions == ActionSource::Discover {
        if let Some(hosted) = core.modules.last() {
            eprintln!("[actions] discovered from module: {:?}", hosted.actions);
        }
    }
    core.ui = ui;
    Ok(scope)
}

/// `--app` mode: host every module the manifest lists, one instance per
/// distinct usage config, and install a component resolver so the entry
/// template can reference them. Returns the entry scope.
fn boot_app(core: &mut Core, manifest_path: &Path) -> Result<String, RuntimeError> {
    let manifest = AppManifest::load(manifest_path)?;

    let mut raw: HashMap<String, String> = HashMap::new();
    let mut files = Vec::new();
    for module in manifest.modules() {
        let source = std::fs::read_to_string(&module.ui)
            .map_err(|e| RuntimeError::io("read", &module.ui, e))?;
        raw.insert(module.name.as_str().to_string(), source);
        files.push(UiFile { name: module.name.as_str().to_string(), path: module.ui.clone() });
    }

    let plan = plan_usages(&manifest, &raw);
    for instance in &plan.instances {
        core.mint(instance_spec(&manifest, instance)?)?;
    }

    let sources = Arc::new(UiSources::new(plan.sources));
    let resolver_sources = Arc::clone(&sources);
    core.engine.set_component_resolver(move |name, _referenced_from| {
        resolver_sources.get(name).map(|source| ResolvedComponent {
            source,
            path: name.to_string(),
            passthrough: false,
            lazy: false,
        })
    });

    let entry = manifest.entry().name.clone();
    let stateless = manifest.modules().iter().filter(|m| !m.is_stateful()).count();
    eprintln!(
        "[app] loaded {} instance(s){}; entry `{entry}`",
        core.modules.len(),
        if stateless > 0 {
            format!(" + {stateless} stateless component(s)")
        } else {
            String::new()
        },
    );

    core.ui = Some(Ui {
        entry: entry.as_str().to_string(),
        files,
        sources,
        app: Some(AppUi { manifest, raw }),
    });
    Ok(entry.scope().as_str().to_string())
}

/// Run the per-usage planner over a manifest's modules.
pub(crate) fn plan_usages(
    manifest: &AppManifest,
    raw: &HashMap<String, String>,
) -> usage_plan::UsagePlan {
    let modules: Vec<PlanModule<'_>> = manifest
        .modules()
        .iter()
        .map(|m| PlanModule { name: m.name.as_str(), stateful: m.is_stateful() })
        .collect();
    usage_plan::plan(&modules, manifest.entry().name.as_str(), raw)
}

/// The instance spec for a planned instance: its backing module's `.wasm`
/// and capabilities, under the planned scope.
pub(crate) fn instance_spec(
    manifest: &AppManifest,
    instance: &PlannedInstance,
) -> Result<InstanceSpec, RuntimeError> {
    let backing = manifest.module(&instance.backing);
    let Some(ModuleKind::Stateful { wasm, capabilities }) = backing.map(|m| &m.kind) else {
        // The planner only plans instances for stateful manifest modules.
        return Err(RuntimeError::Internal("planned instance has no stateful backing module"));
    };
    Ok(InstanceSpec {
        scope: instance.scope.clone(),
        entry: instance.backing.clone(),
        wasm: wasm.clone(),
        manifest: capabilities.to_manifest(&instance.scope),
        config: instance.config.clone(),
        actions: ActionSource::Discover,
    })
}

/// Canonicalise for change-event matching, falling back to the path as given
/// if it does not currently resolve (e.g. mid-rewrite by a build).
pub(crate) fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
pub(crate) mod testing;

#[cfg(test)]
mod tests;
