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
//!    naming the scope(s). (Detected by probing the instances after a failed
//!    dispatch — the engine reports host failures as text, the host's typed
//!    `DeadInstance` answer to the probe is what we trust.)
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

use hypen_engine::dispatch::Action;
use hypen_engine::ir::ResolvedComponent;
use hypen_engine::module_host::{
    DualHost, Effect, ExecStrategy, HostError, ModuleHost, ModuleInstanceId, ModuleLimits,
    ModuleManifest,
};
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
}

impl Core {
    fn host(&mut self) -> Result<&mut (dyn ModuleHost + 'static), RuntimeError> {
        self.engine
            .module_host_mut()
            .ok_or(RuntimeError::Internal("no module host installed"))
    }

    fn module_error(&self, scope: &str, stage: ModuleStage, source: HostError) -> RuntimeError {
        RuntimeError::Module { scope: scope.to_string(), stage, surface: self.surface, source }
    }

    /// (Re-)register a module's component bytes from its `.wasm` file.
    pub fn register_component(&mut self, spec: &InstanceSpec) -> Result<(), RuntimeError> {
        let bytes = std::fs::read(&spec.wasm)
            .map_err(|e| RuntimeError::io("read", &spec.wasm, e))?;
        let manifest = spec.manifest.clone();
        self.host()?
            .register(&spec.scope, &bytes, manifest)
            .map_err(|e| self.module_error(&spec.scope, ModuleStage::Register, e))
    }

    /// Instantiate `scope`'s registered component and run `init`. If anything
    /// after `instantiate` fails, the half-started instance is destroyed
    /// rather than leaked.
    fn start_instance(&mut self, spec: &InstanceSpec) -> Result<Started, RuntimeError> {
        let surface = self.surface;
        let scope = spec.scope.as_str();
        let fail = |stage, source| RuntimeError::Module {
            scope: scope.to_string(),
            stage,
            surface,
            source,
        };
        let host = self.host()?;
        let id = host.instantiate(scope).map_err(|e| fail(ModuleStage::Instantiate, e))?;

        let started = (|| {
            let config = serde_json::to_vec(&spec.config)
                .map_err(|source| RuntimeError::InitState { scope: scope.to_string(), source })?;
            let state_bytes = host.init(id, &config).map_err(|e| fail(ModuleStage::Init, e))?;
            let state: Value = serde_json::from_slice(&state_bytes)
                .map_err(|source| RuntimeError::InitState { scope: scope.to_string(), source })?;
            let actions = match &spec.actions {
                ActionSource::Override(list) => list.clone(),
                ActionSource::Discover => {
                    host.actions(id).map_err(|e| fail(ModuleStage::QueryActions, e))?
                }
            };
            Ok(Started { id, state, actions })
        })();
        if started.is_err() {
            // Best effort: the instance may already be dead (init trapped).
            let _ = host.destroy(id);
        }
        started
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
    pub fn mint(&mut self, spec: InstanceSpec) -> Result<(), RuntimeError> {
        self.register_component(&spec)?;
        let actions = self.start_and_wire(&spec)?;
        self.modules.push(HostedModule { spec, actions, health: Health::Running });
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

    /// Restart every crashed module. Returns the scopes that are *still*
    /// crashed because their restart failed.
    fn revive_crashed(&mut self) -> Vec<String> {
        let mut revived = Vec::new();
        let mut still_crashed = Vec::new();
        for index in 0..self.modules.len() {
            if self.modules[index].health != Health::Crashed {
                continue;
            }
            let scope = self.modules[index].spec.scope.clone();
            match self.restart(index) {
                Ok(()) => {
                    eprintln!(
                        "[crash] module `{scope}` was RESTARTED from its initial config — \
                         the state it held before crashing is lost"
                    );
                    revived.push(scope);
                }
                Err(e) => {
                    eprintln!(
                        "[crash] module `{scope}` could not be restarted (will retry on the \
                         next action): {}",
                        crate::error::one_line(&e)
                    );
                    still_crashed.push(scope);
                }
            }
        }
        if !revived.is_empty() {
            // Show the re-initialised state in the UI.
            if let Err(e) = self.render_entry() {
                eprintln!("[crash] re-render after restart failed: {e}");
            }
        }
        still_crashed
    }

    /// Probe every running instance; mark and return the ones the host says
    /// are dead.
    fn detect_crashes(&mut self) -> Vec<String> {
        let mut crashed = Vec::new();
        for index in 0..self.modules.len() {
            if self.modules[index].health != Health::Running {
                continue;
            }
            let scope = self.modules[index].spec.scope.clone();
            let Some(id) = self.engine.module_instance_id(&scope) else {
                continue;
            };
            let dead = match self.host() {
                Ok(host) => matches!(host.actions(id), Err(HostError::DeadInstance)),
                Err(_) => false,
            };
            if dead {
                self.modules[index].health = Health::Crashed;
                crashed.push(scope);
            }
        }
        crashed
    }

    /// Route one request to the engine (see [`ActionTarget`]).
    fn route(&mut self, request: &DispatchRequest) -> Result<(), EngineError> {
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
                other => return other,
            }
        }
        if let ActionTarget::Scoped { scope, action } = &request.target {
            if self.engine.module_instance_id(scope).is_some() {
                return self.engine.dispatch_module_action(scope, action, request.payload.clone());
            }
        }
        self.engine
            .dispatch_action(Action::new(request.name.as_str()).with_payload(request.payload.clone()))
    }

    /// Classify an engine dispatch failure, detecting crashed instances.
    /// `still_crashed` are modules whose restart just failed — a module
    /// failure with those around is reported as a crash too.
    fn classify(
        &mut self,
        result: Result<(), EngineError>,
        mut still_crashed: Vec<String>,
    ) -> Result<(), RuntimeError> {
        match result {
            Ok(()) => Ok(()),
            Err(source @ EngineError::ModuleError(_)) => {
                let newly = self.detect_crashes();
                for scope in &newly {
                    eprintln!(
                        "[crash] module `{scope}` CRASHED ({source}). Its state is lost; it \
                         will be re-instantiated and re-initialised on the next action."
                    );
                }
                still_crashed.extend(newly);
                if still_crashed.is_empty() {
                    return Err(RuntimeError::Dispatch(source));
                }
                Err(RuntimeError::ModuleCrashed { scopes: still_crashed, source })
            }
            Err(other) => Err(RuntimeError::Dispatch(other)),
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
        let mut limits = ModuleLimits::default();
        if let Some(max_call) = options.call_timeout {
            limits.max_call = max_call;
        }
        // Dual-ABI host: v0.1 sync and v0.2 CM-async components both boot
        // here; `register` sniffs which world the bytes target.
        let host = DualHost::with_options(limits, ExecStrategy::default(), options.data_dir.as_deref())
            .map_err(|source| RuntimeError::HostStart { source })?;
        Self::boot_with_host(&options.source, Box::new(host))
    }

    /// Boot on any [`ModuleHost`] (tests use a fake one).
    pub fn boot_with_host(
        source: &Source,
        host: Box<dyn ModuleHost>,
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
        let mut core = Core { engine, modules: Vec::new(), ui: None, surface };
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

        let runtime = Runtime { core: Mutex::new(core), hub, outbox, entry_scope };
        Ok(Booted { runtime, initial_patches })
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
        let result = core.classify(routed, still_crashed);
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
        let still_crashed = core.revive_crashed();
        let fired = core.engine.dispatch_module_action(scope, action, Value::Null);
        if let Err(e) = core.classify(fired, still_crashed) {
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
