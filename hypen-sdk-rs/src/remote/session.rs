use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use hypen_engine::{Engine, Patch};
use serde_json::Value;

use crate::context::GlobalContext;
use crate::discovery::ComponentRegistry;
use crate::module::{ActionHandler, ModuleDefinition};
use crate::router::HypenRouter;
use crate::state::State;

use super::types::RemoteMessage;

/// Configuration for creating a [`RemoteSession`].
pub struct SessionConfig {
    /// Module name (e.g., "App").
    pub module_name: String,
    /// Hypen DSL source for the root UI.
    pub ui_source: String,
    /// Component registry with discovered components.
    pub components: ComponentRegistry,
    /// Initial state as JSON.
    pub initial_state: Value,
    /// Action names registered on this module.
    pub action_names: Vec<String>,
    /// SVG resources (name → raw SVG string) for resolving
    /// `Icon(@resources.xxx)` references. Without these, the engine leaves
    /// the raw `@resources.xxx` reference in the Create patch props and
    /// renderers display a fallback glyph (e.g. "...") instead of the icon.
    pub resources: indexmap::IndexMap<String, String>,
    /// Additional named modules to register on the engine.
    /// Each entry is `(module_name, initial_state_json, action_names)`.
    /// These are registered via `Engine::register_module` so nested
    /// `module Foo { ... }` blocks in DSL can bind to real state.
    pub modules: Vec<(String, Value, Vec<String>)>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            module_name: String::new(),
            ui_source: String::new(),
            components: ComponentRegistry::new(),
            initial_state: Value::Null,
            action_names: Vec::new(),
            resources: indexmap::IndexMap::new(),
            modules: vec![],
        }
    }
}

/// Type-erased action handler: `(action_name, payload, current_state) -> new_state`.
///
/// Wrapped in `Arc` so the same handler can be shared between the
/// `primary_handler` slot and the engine-side `on_action` placeholder
/// closures registered at session construction.
type ActionHandlerFn = Arc<dyn Fn(&str, Option<&Value>, &Value) -> Value + Send + Sync>;

/// Type-erased module configuration for nested modules in a [`RemoteSession`].
///
/// Wraps a [`ModuleDefinition`] of any state type into a form that can be
/// passed alongside the primary module when building a session.
///
/// # Example
///
/// ```rust,ignore
/// let search = Arc::new(HypenApp::module::<SearchState>("Search")
///     .state(SearchState { query: String::new(), results: vec![] })
///     .on_action::<SearchPayload>("search", |state, payload, _| {
///         state.results = do_search(&state.query);
///     })
///     .build());
///
/// let search_cfg = ModuleSessionConfig::from_definition(search);
/// ```
pub struct ModuleSessionConfig {
    pub(crate) name: String,
    pub(crate) initial_state: Value,
    pub(crate) action_handler: ActionHandlerFn,
    pub(crate) action_names: Vec<String>,
}

impl ModuleSessionConfig {
    /// Create a module config from a [`ModuleDefinition`], using the
    /// definition's initial state.
    pub fn from_definition<S: State>(def: Arc<ModuleDefinition<S>>) -> Self {
        let initial_state = serde_json::to_value(&def.initial_state).unwrap_or(Value::Null);
        Self::build(def, initial_state)
    }

    /// Create a module config with a per-client state override.
    pub fn from_definition_with_state<S: State>(def: Arc<ModuleDefinition<S>>, state: S) -> Self {
        let initial_state = serde_json::to_value(&state).unwrap_or(Value::Null);
        Self::build(def, initial_state)
    }

    fn build<S: State>(def: Arc<ModuleDefinition<S>>, initial_state: Value) -> Self {
        let name = def.name.clone();
        let action_names = def.action_names();
        let handler: ActionHandlerFn = Arc::new(move |action, payload, state_json| {
            // `__hypen_bind` short-circuit: renderer-side two-way binding.
            // No user handler is registered for this name; we rewrite state
            // at the dotted path directly. Validates against `S` so a bind
            // to a non-existent field is silently dropped (matching TS/JS
            // proxy semantics). See ENGINE_CONTRACT.md §13.
            if action == "__hypen_bind" {
                if let Some(payload_val) = payload {
                    if let Some(obj) = payload_val.as_object() {
                        if let Some(path) = obj.get("path").and_then(|p| p.as_str()) {
                            let value = obj.get("value").cloned().unwrap_or(Value::Null);
                            if let Some(new_state) =
                                crate::state::apply_bind_to_json::<S>(state_json, path, value)
                            {
                                return new_state;
                            }
                        }
                    }
                }
                return state_json.clone();
            }

            let mut state: S = match serde_json::from_value(state_json.clone()) {
                Ok(s) => s,
                Err(_) => return state_json.clone(),
            };
            // Remote sessions only run sync handlers — async handlers
            // would need an executor we don't own here.
            if let Some(ActionHandler::Sync(h)) = def.action_handlers.get(action) {
                h(&mut state, payload, None);
            }
            serde_json::to_value(&state).unwrap_or_else(|_| state_json.clone())
        });
        Self {
            name,
            initial_state,
            action_handler: handler,
            action_names,
        }
    }
}

/// Per-client remote session managing an engine, state, and the wire protocol.
///
/// Framework-agnostic: feed it JSON strings, get JSON strings back.
/// Wire it into any WebSocket library (Axum, Actix, Tungstenite, etc.).
///
/// # Usage
///
/// ```rust,ignore
/// let config = SessionConfig { /* ... */ };
/// let session = RemoteSession::new(config);
/// session.set_action_handler(|action, payload, state| { /* ... */ });
///
/// // On client connect:
/// let msgs = session.handle_hello(None);
/// for m in msgs { ws.send(m); }
///
/// // On each incoming message:
/// let responses = session.handle_message(&incoming_json);
/// for r in responses { ws.send(r); }
/// ```
/// Type-erased disconnect handler: `(state_json, session_info) -> ()`.
type DisconnectHandlerFn = Box<dyn Fn(&Value, &super::SessionInfo) + Send + Sync>;
/// Type-erased reconnect handler: `(state_json_mut, session_info, saved_state) -> ()`.
type ReconnectHandlerFn = Box<dyn Fn(&mut Value, &super::SessionInfo, &Value) + Send + Sync>;
/// Type-erased expire handler: `(session_info) -> ()`.
type ExpireHandlerFn = Box<dyn Fn(&super::SessionInfo) + Send + Sync>;

/// Type-erased route activation handler. Receives the matched params,
/// the shared state map (mutable), and the session's [`GlobalContext`].
/// Fires from the `router.*` action handlers after every navigation
/// (including the initial mount via [`handle_hello`](RemoteSession::handle_hello)).
/// Use [`RemoteSession::on_route_enter`] to register one.
type RouteActivationFn = Box<
    dyn Fn(&HashMap<String, String>, &mut HashMap<String, Value>, &Arc<GlobalContext>)
        + Send
        + Sync,
>;

pub struct RemoteSession {
    inner: Mutex<SessionInner>,
    /// Per-session state for primary and nested modules.
    state: Arc<Mutex<HashMap<String, Value>>>,
    /// Catch-all primary-module action handler set via [`set_action_handler`].
    primary_handler: Arc<Mutex<Option<ActionHandlerFn>>>,
    /// Route-entry hooks registered via [`Self::on_route_enter`]. Fired
    /// from the `router.*` engine action handlers after every nav so
    /// per-route modules can load route-param-dependent data (e.g.
    /// `/comments/:postId` → load comments) without a bespoke
    /// pre-navigation action.
    route_hooks: Arc<Mutex<Vec<(String, RouteActivationFn)>>>,
    /// Type-erased session lifecycle handlers, populated by `build_from_definition`.
    on_disconnect: Option<DisconnectHandlerFn>,
    on_reconnect: Option<ReconnectHandlerFn>,
    on_expire: Option<ExpireHandlerFn>,
    /// Per-session router. The engine's reserved `router.*` action
    /// namespace (installed in [`Self::new`]) drives this router, and
    /// the accessor [`Self::router`] lets callers attach a
    /// [`crate::managed_router::ManagedRouter`] or subscribe to
    /// `on_navigate` for custom mount/unmount logic.
    router: Arc<HypenRouter>,
    /// Per-session [`GlobalContext`]. Exposed so callers that attach a
    /// [`ManagedRouter`](crate::managed_router::ManagedRouter) can reuse
    /// the same context instance the router is already aware of.
    context: Arc<GlobalContext>,
    module_name: String,
    session_id: String,
}

struct SessionInner {
    engine: Engine,
    ui_source: String,
    revision: u64,
    state_subscribed: bool,
    rendered: bool,
}

impl RemoteSession {
    /// Create a new remote session.
    ///
    /// Sets up the engine with the component resolver and module, but does NOT
    /// render yet. The initial render happens in [`handle_hello`].
    pub fn new(config: SessionConfig) -> Self {
        let session_id = format!(
            "session_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );

        let mut engine = Engine::new();

        // Wire up component resolver from the registry
        let registry = Arc::new(config.components);
        let reg: Arc<ComponentRegistry> = Arc::clone(&registry);
        engine.set_component_resolver(move |name, _ctx_path| {
            reg.get(name).map(|entry| hypen_engine::ir::ResolvedComponent {
                source: entry.source.clone(),
                path: entry
                    .path
                    .as_ref()
                    .map(|p: &PathBuf| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                passthrough: false,
                lazy: false,
            })
        });

        // Set the primary module (state + action declarations). Note that
        // `set_module` does NOT populate the engine's action->module scope
        // map, so primary-module actions resolve to `None` in
        // `engine.action_scope_for()`.
        let module_meta = hypen_engine::Module::new(&config.module_name)
            .with_actions(config.action_names.clone());
        let engine_module =
            hypen_engine::ModuleInstance::new(module_meta, config.initial_state.clone());
        engine.set_module(engine_module);

        // Register resources (name → raw SVG) so `Icon(@resources.xxx)` can
        // be resolved into concrete path data during render. This MUST happen
        // before handle_hello triggers the initial render.
        for (name, svg) in &config.resources {
            engine.register_resource(name, svg);
        }

        // Register additional named modules (for nested `module Foo { … }` blocks).
        for (name, initial_state, action_names) in &config.modules {
            let module_meta =
                hypen_engine::Module::new(name).with_actions(action_names.clone());
            let module_inst =
                hypen_engine::ModuleInstance::new(module_meta, initial_state.clone());
            engine.register_module(name, module_inst);
        }

        // Build the per-session state map. Key `""` is the primary slot;
        // lowercase module names match `engine.action_scope_for(...)` returns.
        let mut state_map: HashMap<String, Value> = HashMap::new();
        state_map.insert(String::new(), config.initial_state.clone());
        for (name, initial_state, _) in &config.modules {
            state_map.insert(name.to_lowercase(), initial_state.clone());
        }
        let state = Arc::new(Mutex::new(state_map));
        let primary_handler: Arc<Mutex<Option<ActionHandlerFn>>> = Arc::new(Mutex::new(None));

        // Register engine-side placeholder closures for each primary action
        // name. Firing one of these (via `engine.dispatch_action(...)`) reads
        // the catch-all primary handler set via `set_action_handler` and
        // mutates the shared state map. State is pushed to the engine *after*
        // dispatch returns, in `handle_action`.
        for action_name in &config.action_names {
            let name = action_name.clone();
            let state_arc = Arc::clone(&state);
            let handler_arc = Arc::clone(&primary_handler);
            engine.on_action(name.clone(), move |action| {
                let handler_guard = handler_arc.lock().unwrap();
                let Some(handler) = handler_guard.as_ref() else { return };
                let mut state_guard = state_arc.lock().unwrap();
                let current = state_guard.get("").cloned().unwrap_or(Value::Null);
                let new_state = handler(&name, action.payload.as_ref(), &current);
                state_guard.insert(String::new(), new_state);
            });
        }

        // Per-session router + context. The router is driven both
        // internally (by the `router.*` engine action handlers
        // installed below) and externally (callers can subscribe via
        // `session.router().on_navigate(...)` or attach a
        // `ManagedRouter`).
        let router = Arc::new(HypenRouter::new());
        let context = Arc::new(GlobalContext::new());
        context.set_router(Arc::clone(&router));

        let route_hooks: Arc<Mutex<Vec<(String, RouteActivationFn)>>> =
            Arc::new(Mutex::new(Vec::new()));

        // Install the reserved `@router.*` action namespace. This lets
        // DSL authors write `.onClick(@router.push, to: "/search")`
        // and have it dispatch straight to `router.push("/search")`
        // without any host-side wiring — parity with the TS / Go /
        // Swift / Kotlin SDKs.
        //
        // The handlers also mirror the new path into primary-module
        // state under the `location` key (when the state shape carries
        // one). Rendering is then driven by whatever Router IR block
        // is bound to `@{state.location}` in the primary UI. No defer
        // is needed here — we're already running inside the engine's
        // `dispatch_action` under `handle_action`'s `with_capture`
        // window, so the subsequent `engine.update_state(None, ...)`
        // that the primary-state write triggers lands in the same
        // patch response.
        let install_router_handler = |engine: &mut Engine, name: &'static str| {
            let router = Arc::clone(&router);
            let state_arc = Arc::clone(&state);
            let hooks = Arc::clone(&route_hooks);
            let ctx = Arc::clone(&context);
            engine.on_action(name, move |action| {
                let to = action
                    .payload
                    .as_ref()
                    .and_then(|p| p.get("to"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let new_path = match name {
                    "router.push" => to.and_then(|t| {
                        router.push(&t);
                        Some(router.current_path())
                    }),
                    "router.replace" => to.and_then(|t| {
                        router.replace(&t);
                        Some(router.current_path())
                    }),
                    "router.back" => {
                        router.back();
                        Some(router.current_path())
                    }
                    _ => None, // router.forward: server-side no-op
                };
                let Some(path) = new_path else { return };
                // Mirror path into primary state.location (when present)
                // and fire matching route hooks. Both happen under the
                // state mutex so the engine's `update_state` pass in
                // `handle_action` sees a consistent view.
                let mut g = state_arc.lock().unwrap();
                if let Some(primary) = g.get_mut("") {
                    if let Some(obj) = primary.as_object_mut() {
                        if obj.contains_key("location") {
                            obj.insert("location".to_string(), Value::String(path.clone()));
                        }
                    }
                }
                let hooks_guard = hooks.lock().unwrap();
                for (pattern, hook) in hooks_guard.iter() {
                    if let Some(m) = hypen_engine::match_path(pattern, &path) {
                        let params: HashMap<String, String> = m.params.into_iter().collect();
                        hook(&params, &mut g, &ctx);
                    }
                }
            });
        };
        install_router_handler(&mut engine, "router.push");
        install_router_handler(&mut engine, "router.replace");
        install_router_handler(&mut engine, "router.back");
        install_router_handler(&mut engine, "router.forward");

        Self {
            inner: Mutex::new(SessionInner {
                engine,
                ui_source: config.ui_source,
                revision: 0,
                state_subscribed: false,
                rendered: false,
            }),
            state,
            primary_handler,
            on_disconnect: None,
            on_reconnect: None,
            on_expire: None,
            router,
            context,
            route_hooks,
            module_name: config.module_name,
            session_id,
        }
    }

    /// Register a route-entry hook.
    ///
    /// Called whenever the session's router lands on `pattern` (via any
    /// `@router.push` / `@router.replace` / `@router.back` dispatch).
    /// The hook receives the extracted route params, a mutable handle
    /// to the shared state map (keyed by lowercase module name; `""`
    /// = primary), and the session's [`GlobalContext`].
    ///
    /// Typical use: load data for a `:id` / `:postId` route and write
    /// it into the corresponding nested module's state slot. The state
    /// changes are flushed to the engine at the end of the surrounding
    /// [`handle_action`](Self::handle_action) call, so any patches land
    /// in the same WebSocket response.
    ///
    /// ```rust,ignore
    /// session.on_route_enter("/comments/:postId", move |params, state, _ctx| {
    ///     let post_id = params.get("postId").cloned().unwrap_or_default();
    ///     let comments = load_comments(&db, &post_id);
    ///     if let Some(slot) = state.get_mut("comments") {
    ///         if let Some(obj) = slot.as_object_mut() {
    ///             obj.insert("postId".into(), Value::String(post_id));
    ///             obj.insert("comments".into(), serde_json::to_value(&comments).unwrap());
    ///         }
    ///     }
    /// });
    /// ```
    pub fn on_route_enter<F>(&self, pattern: impl Into<String>, handler: F)
    where
        F: Fn(&HashMap<String, String>, &mut HashMap<String, Value>, &Arc<GlobalContext>)
            + Send
            + Sync
            + 'static,
    {
        self.route_hooks
            .lock()
            .unwrap()
            .push((pattern.into(), Box::new(handler)));
    }

    /// The router driving this session.
    ///
    /// The engine's reserved `router.*` action namespace is wired to
    /// this router automatically in [`Self::new`] — DSL authors get
    /// `@router.push` / `@router.replace` / `@router.back` for free.
    /// Callers that want programmatic nav, to subscribe to
    /// `on_navigate`, or to attach a
    /// [`ManagedRouter`](crate::managed_router::ManagedRouter) use this
    /// handle.
    pub fn router(&self) -> &Arc<HypenRouter> {
        &self.router
    }

    /// The global context associated with this session.
    ///
    /// Paired with [`Self::router`]; the session sets the router on the
    /// context at construction so any attached `ManagedRouter` can find
    /// it via `context.router()`.
    pub fn context(&self) -> &Arc<GlobalContext> {
        &self.context
    }

    /// Create a session from a [`ModuleDefinition`], automatically wiring up
    /// typed action handlers, UI source, and resources.
    ///
    /// This is the recommended way to create a `RemoteSession` when using the
    /// [`ModuleBuilder`](crate::module::ModuleBuilder) API. It eliminates manual
    /// `SessionConfig` construction and raw action handler closures.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let module = Arc::new(HypenApp::module::<MyState>("App")
    ///     .state(MyState::default())
    ///     .ui_file("./components/App/component.hypen")
    ///     .on_action::<()>("increment", |s, _, _| s.count += 1)
    ///     .build());
    ///
    /// let session = RemoteSession::from_definition(module, components);
    /// ```
    pub fn from_definition<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
    ) -> Self {
        Self::build_from_definition(def, components, None, vec![])
    }

    /// Create a session from a [`ModuleDefinition`] with a per-client state
    /// override and optional nested modules.
    ///
    /// Use this when initial state varies per client (e.g., loaded from a
    /// database for the connected user).
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let search_mod = Arc::new(HypenApp::module::<SearchState>("Search")
    ///     .state(SearchState::default())
    ///     .on_action::<()>("search", |s, _, _| { /* filter */ })
    ///     .build());
    ///
    /// let session = RemoteSession::from_definition_with_state(
    ///     app_module.clone(),
    ///     components,
    ///     client_state,
    ///     vec![ModuleSessionConfig::from_definition(search_mod)],
    /// );
    /// ```
    pub fn from_definition_with_state<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
        initial_state: S,
        modules: Vec<ModuleSessionConfig>,
    ) -> Self {
        Self::build_from_definition(def, components, Some(initial_state), modules)
    }

    /// Internal constructor shared by `from_definition` variants.
    fn build_from_definition<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
        state_override: Option<S>,
        modules: Vec<ModuleSessionConfig>,
    ) -> Self {
        let state_ref = state_override.as_ref().unwrap_or(&def.initial_state);
        let initial_state_json = serde_json::to_value(state_ref).unwrap_or(Value::Null);

        let ui_source = def
            .ui_source
            .clone()
            .or_else(|| {
                def.ui_file
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
            })
            .unwrap_or_default();

        // Extract (name, state, actions) tuples for SessionConfig + collect handlers
        let raw_modules: Vec<(String, Value, Vec<String>)> = modules
            .iter()
            .map(|m| (m.name.clone(), m.initial_state.clone(), m.action_names.clone()))
            .collect();

        let config = SessionConfig {
            module_name: def.name.clone(),
            ui_source,
            components,
            initial_state: initial_state_json,
            action_names: def.action_names(),
            resources: def.resource_map.clone(),
            modules: raw_modules,
        };

        let mut session = Self::new(config);

        // Clone the definition Arc BEFORE the move-capture below so the
        // lifecycle handler closures can still reference it.
        let def_for_disconnect = Arc::clone(&def);
        let def_for_reconnect = Arc::clone(&def);
        let def_for_expire = Arc::clone(&def);

        // Bridge: route primary-module action dispatches to the definition's
        // typed handlers via the catch-all `set_action_handler` slot. The
        // engine-side placeholder closures registered in `Self::new` for each
        // primary action name read this slot when fired.
        session.set_action_handler(move |action, payload, state_json| {
            // `__hypen_bind` short-circuit — see the note in `Self::build`.
            if action == "__hypen_bind" {
                if let Some(payload_val) = payload {
                    if let Some(obj) = payload_val.as_object() {
                        if let Some(path) = obj.get("path").and_then(|p| p.as_str()) {
                            let value = obj.get("value").cloned().unwrap_or(Value::Null);
                            if let Some(new_state) =
                                crate::state::apply_bind_to_json::<S>(state_json, path, value)
                            {
                                return new_state;
                            }
                        }
                    }
                }
                return state_json.clone();
            }

            let mut state: S = match serde_json::from_value(state_json.clone()) {
                Ok(s) => s,
                Err(_) => return state_json.clone(),
            };
            if let Some(ActionHandler::Sync(handler)) = def.action_handlers.get(action) {
                handler(&mut state, payload, None);
            }
            serde_json::to_value(&state).unwrap_or_else(|_| state_json.clone())
        });

        // Register nested module action handlers on the engine itself, one
        // closure per (module, action) pair. Each closure shares the
        // module's type-erased `action_handler` (via the Arc inside
        // `ModuleSessionConfig`) and mutates the per-session state map under
        // the lowercase module-name key — matching what
        // `engine.action_scope_for(...)` returns.
        {
            let mut inner = session.inner.lock().unwrap();
            for module_cfg in modules {
                let scope_key = module_cfg.name.to_lowercase();
                let handler = Arc::clone(&module_cfg.action_handler);
                for action_name in &module_cfg.action_names {
                    let action = action_name.clone();
                    let scope = scope_key.clone();
                    let h = Arc::clone(&handler);
                    let state_arc = Arc::clone(&session.state);
                    inner.engine.on_action(action.clone(), move |evt| {
                        let mut state_guard = state_arc.lock().unwrap();
                        let current = state_guard.get(&scope).cloned().unwrap_or(Value::Null);
                        let new_state = h(&action, evt.payload.as_ref(), &current);
                        state_guard.insert(scope.clone(), new_state);
                    });
                }
            }
        }

        // Build type-erased session lifecycle wrappers from the typed
        // definition handlers. Each wrapper deserializes the JSON state
        // into S, calls the typed handler, and serializes back.
        if def_for_disconnect.on_disconnect.is_some() {
            session.on_disconnect = Some(Box::new(move |state_json, session_info| {
                if let Some(ref handler) = def_for_disconnect.on_disconnect {
                    if let Ok(state) = serde_json::from_value::<S>(state_json.clone()) {
                        handler(&state, session_info);
                    }
                }
            }));
        }
        if def_for_reconnect.on_reconnect.is_some() {
            session.on_reconnect = Some(Box::new(move |state_json, session_info, saved_state| {
                if let Some(ref handler) = def_for_reconnect.on_reconnect {
                    if let Ok(mut state) = serde_json::from_value::<S>(state_json.clone()) {
                        handler(&mut state, session_info, saved_state);
                        if let Ok(new_json) = serde_json::to_value(&state) {
                            *state_json = new_json;
                        }
                    }
                }
            }));
        }
        if def_for_expire.on_expire.is_some() {
            session.on_expire = Some(Box::new(move |session_info| {
                if let Some(ref handler) = def_for_expire.on_expire {
                    handler(session_info);
                }
            }));
        }

        session
    }

    /// Set the action handler for the session's primary module.
    ///
    /// Called whenever a `dispatchAction` message arrives whose action
    /// belongs to the primary module (i.e. `engine.action_scope_for` returns
    /// `None`). The handler receives the action name, optional payload, and
    /// current primary-module state, and must return the new state.
    ///
    /// Nested-module handlers are installed internally by
    /// [`from_definition_with_state`](Self::from_definition_with_state).
    pub fn set_action_handler<F>(&self, handler: F)
    where
        F: Fn(&str, Option<&Value>, &Value) -> Value + Send + Sync + 'static,
    {
        *self.primary_handler.lock().unwrap() = Some(Arc::new(handler));
    }

    /// The session ID assigned to this client.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Handle the hello handshake. Returns `[sessionAck, initialTree]` as JSON.
    ///
    /// If `client_session_id` is `Some(id)` and a `SessionManager` was used
    /// to suspend that session earlier, the caller should call
    /// [`handle_reconnect`](Self::handle_reconnect) with the
    /// `PendingSession.saved_state` BEFORE calling this method so the state
    /// is restored before the initial render.
    ///
    /// Call this either:
    /// - When you receive a `hello` message from the client, or
    /// - Immediately after connection (for clients that don't send hello)
    pub fn handle_hello(&self, client_session_id: Option<&str>) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let mut messages = Vec::with_capacity(2);

        let is_restored = client_session_id.is_some();

        // 1. sessionAck
        let ack = RemoteMessage::SessionAck {
            session_id: client_session_id
                .unwrap_or(&self.session_id)
                .to_string(),
            is_new: !is_restored,
            is_restored,
        };
        if let Ok(json) = ack.to_json() {
            messages.push(json);
        }

        // 2. Render the UI (first time only) and capture patches
        let patches = if !inner.rendered {
            inner.rendered = true;
            let ui = inner.ui_source.clone();
            render_and_capture(&mut inner.engine, &ui)
        } else {
            vec![]
        };

        // 3. initialTree
        let primary_state = self
            .state
            .lock()
            .unwrap()
            .get("")
            .cloned()
            .unwrap_or(Value::Null);
        let initial = RemoteMessage::InitialTree {
            module: self.module_name.clone(),
            state: primary_state,
            patches,
            revision: 0,
        };
        if let Ok(json) = initial.to_json() {
            messages.push(json);
        }

        messages
    }

    /// Handle an incoming JSON message. Returns response messages as JSON strings.
    pub fn handle_message(&self, json: &str) -> Vec<String> {
        let msg = match RemoteMessage::from_json(json) {
            Ok(m) => m,
            Err(_) => return vec![],
        };

        match msg {
            RemoteMessage::Hello { session_id, .. } => {
                self.handle_hello(session_id.as_deref())
            }

            RemoteMessage::DispatchAction {
                module,
                action,
                payload,
            } => self.handle_action(&module, &action, payload.as_ref()),

            RemoteMessage::SubscribeState { .. } => {
                self.inner.lock().unwrap().state_subscribed = true;
                vec![]
            }

            _ => vec![],
        }
    }

    /// Dispatch an action and return response messages.
    ///
    /// Builds an [`Action`](hypen_engine::Action) and fires it via
    /// `engine.dispatch_action(...)`. The engine routes it to the handler
    /// closure registered in [`Self::new`] (for primary actions) or in
    /// [`Self::build_from_definition`] (for nested-module actions). Each
    /// handler mutates the per-session state map; this method then reads
    /// the new state out and pushes it back to the engine via
    /// `engine.update_state(...)`, capturing any patches.
    ///
    /// The `module` field on the incoming message is advisory: the engine's
    /// action scope map is authoritative.
    fn handle_action(
        &self,
        _module: &str,
        action: &str,
        payload: Option<&Value>,
    ) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let mut messages = Vec::new();

        // Build the action and dispatch through the engine. This fires the
        // closure registered via `engine.on_action(...)` at session creation,
        // which mutates the per-session state map under the action's scope.
        let mut action_obj = hypen_engine::dispatch::Action::new(action);
        if let Some(p) = payload {
            action_obj = action_obj.with_payload(p.clone());
        }

        let state_arc = Arc::clone(&self.state);
        // Snapshot state before dispatch so we can detect which scopes
        // the handler (and any `router.*` route-enter hooks it triggers)
        // mutated. Without this flush, route-enter mutations to sibling
        // scopes would stay in the state map but never reach the
        // engine, so no patches would ship.
        let pre: HashMap<String, Value> = state_arc.lock().unwrap().clone();
        let patches = with_capture(&mut inner.engine, |engine| {
            // Run the engine-side handler. Errors here mean no handler is
            // registered (e.g. unknown action) — we still proceed to push
            // any changed scopes below so the engine sees a consistent
            // revision.
            let _ = engine.dispatch_action(action_obj);
            // Diff the state map against the pre-dispatch snapshot and
            // push every scope whose value changed. `""` is the primary
            // slot (passed as `None`); every other key is a nested
            // module's lowercased name.
            let post = state_arc.lock().unwrap().clone();
            for (key, new_state) in &post {
                if pre.get(key) != Some(new_state) {
                    let scope_opt = if key.is_empty() { None } else { Some(key.as_str()) };
                    engine.update_state(scope_opt, new_state.clone());
                }
            }
        });

        inner.revision += 1;

        if !patches.is_empty() {
            let patch_msg = RemoteMessage::Patch {
                module: self.module_name.clone(),
                patches,
                revision: inner.revision,
            };
            if let Ok(json) = patch_msg.to_json() {
                messages.push(json);
            }
        }

        if inner.state_subscribed {
            // Read the primary state for the StateUpdate message — even when
            // the action targeted a nested module, the wire protocol's
            // StateUpdate is keyed to the primary module name.
            let primary_state = self
                .state
                .lock()
                .unwrap()
                .get("")
                .cloned()
                .unwrap_or(Value::Null);
            let state_msg = RemoteMessage::StateUpdate {
                module: self.module_name.clone(),
                state: primary_state,
                revision: inner.revision,
            };
            if let Ok(json) = state_msg.to_json() {
                messages.push(json);
            }
        }

        messages
    }

    /// Get a snapshot of the current primary-module state.
    pub fn get_state(&self) -> Value {
        self.state
            .lock()
            .unwrap()
            .get("")
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Get the current revision number.
    pub fn revision(&self) -> u64 {
        self.inner.lock().unwrap().revision
    }

    // -----------------------------------------------------------------
    // Session lifecycle hooks
    // -----------------------------------------------------------------

    /// Fire the `on_disconnect` handler with a snapshot of the current
    /// primary-module state. Call this when the last WebSocket connection
    /// for the session drops and you're about to suspend it via
    /// [`SessionManager::suspend_session`].
    ///
    /// No-op if no `on_disconnect` handler was registered on the
    /// [`ModuleDefinition`] (i.e. the session was created via
    /// `RemoteSession::new` without `from_definition`).
    pub fn fire_disconnect(&self, session_info: &super::SessionInfo) {
        if let Some(ref handler) = self.on_disconnect {
            let state = self.get_state();
            handler(&state, session_info);
        }
    }

    /// Fire the `on_reconnect` handler and apply the saved state to the
    /// session. Call this when a client resumes a suspended session
    /// (i.e. after [`SessionManager::resume_session`] returns
    /// `Some(pending)`).
    ///
    /// The handler receives a mutable reference to the current primary
    /// state (as JSON) and the saved state — it can choose to merge,
    /// replace, or ignore the saved state. If no handler is registered,
    /// the saved state replaces the primary state directly.
    pub fn fire_reconnect(&self, session_info: &super::SessionInfo, saved_state: &Value) {
        let mut state_guard = self.state.lock().unwrap();
        let current = state_guard.get_mut("").unwrap();
        if let Some(ref handler) = self.on_reconnect {
            handler(current, session_info, saved_state);
        } else {
            // Default: apply saved state directly.
            *current = saved_state.clone();
        }
    }

    /// Fire the `on_expire` handler. Call this from the
    /// [`SessionManager`] suspension's `on_expire` callback when the TTL
    /// elapses without a reconnect.
    pub fn fire_expire(&self, session_info: &super::SessionInfo) {
        if let Some(ref handler) = self.on_expire {
            handler(session_info);
        }
    }
}

/// Run a closure with a temporary render callback installed on `engine`,
/// then return whatever patches it produced.
///
/// This is the shared "attach callback → mutate engine → detach → drain"
/// dance used by every state-mutating helper in this module. Pulling it
/// into one place keeps the per-call sites focused on the actual mutation.
fn with_capture<F>(engine: &mut Engine, mutate: F) -> Vec<Patch>
where
    F: FnOnce(&mut Engine),
{
    let patches = Arc::new(Mutex::new(Vec::<Patch>::new()));
    let capture = Arc::clone(&patches);
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    mutate(engine);

    engine.set_render_callback(|_| {});

    let mut guard = patches.lock().unwrap();
    std::mem::take(&mut *guard)
}

/// Parse + render DSL source, capturing patches via a temporary render callback.
fn render_and_capture(engine: &mut Engine, ui_source: &str) -> Vec<Patch> {
    with_capture(engine, |engine| {
        if let Ok(doc) = hypen_parser::parse_document(ui_source) {
            if let Some(component) = doc.components.first() {
                let ir_node = hypen_engine::ast_to_ir_node(component);
                engine.render_ir_node(&ir_node);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> SessionConfig {
        let mut components = ComponentRegistry::new();
        components.register(
            "Greeting",
            r#"Text("Hello @{state.name}")"#,
            None,
        );

        SessionConfig {
            module_name: "App".to_string(),
            ui_source: r#"Column { Text("Count: @{state.count}") }"#.to_string(),
            components,
            initial_state: serde_json::json!({
                "count": 0,
                "name": "World"
            }),
            action_names: vec!["increment".to_string()],
            resources: indexmap::IndexMap::new(),
            modules: Vec::new(),
        }
    }

    #[test]
    fn test_session_hello_returns_ack_and_tree() {
        let session = RemoteSession::new(test_config());
        let msgs = session.handle_hello(None);

        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].contains("sessionAck"));
        assert!(msgs[1].contains("initialTree"));
        assert!(msgs[1].contains("\"count\":0"));
    }

    #[test]
    fn test_session_dispatch_action() {
        let session = RemoteSession::new(test_config());
        session.set_action_handler(|action, _payload, state| {
            let mut s = state.clone();
            if action == "increment" {
                if let Some(count) = s.get_mut("count").and_then(|v| v.as_i64()) {
                    s["count"] = serde_json::json!(count + 1);
                }
            }
            s
        });

        // Initial render
        let _ = session.handle_hello(None);

        // Dispatch action
        let action_json = r#"{"type":"dispatchAction","module":"App","action":"increment"}"#;
        let _responses = session.handle_message(action_json);

        // Should get patch message back (if engine produced patches)
        assert!(session.get_state()["count"] == 1);
        assert_eq!(session.revision(), 1);
    }

    #[test]
    fn test_session_state_subscription() {
        let session = RemoteSession::new(test_config());
        session.set_action_handler(|_action, _payload, state| {
            let mut s = state.clone();
            s["count"] = serde_json::json!(42);
            s
        });

        let _ = session.handle_hello(None);

        // Subscribe to state
        let sub_json = r#"{"type":"subscribeState","module":"App"}"#;
        session.handle_message(sub_json);

        // Now dispatch — should get stateUpdate in response
        let action_json = r#"{"type":"dispatchAction","module":"App","action":"set"}"#;
        let responses = session.handle_message(action_json);

        // Should contain a stateUpdate message
        let has_state_update = responses.iter().any(|r| r.contains("stateUpdate"));
        assert!(has_state_update);
    }

    #[test]
    fn test_session_hello_via_message() {
        let session = RemoteSession::new(test_config());
        let hello_json = r#"{"type":"hello"}"#;
        let msgs = session.handle_message(hello_json);

        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].contains("sessionAck"));
        assert!(msgs[1].contains("initialTree"));
    }

    /// Regression: `SessionConfig.resources` must reach the per-session engine
    /// so `Icon(@resources.xxx)` resolves to real `__iconPaths` on the wire.
    /// Before the fix, the field did not exist and `RemoteSession::new`
    /// instantiated an engine with no resources — every Icon patch carried
    /// the raw "@resources.xxx" reference string in props and renderers
    /// displayed a fallback glyph (e.g. "...").
    #[test]
    fn test_session_resources_reach_engine_and_render() {
        let components = ComponentRegistry::new();

        let mut resources = indexmap::IndexMap::new();
        let heart_svg = r#"<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z" stroke="currentColor"/></svg>"#;
        resources.insert("heart".to_string(), heart_svg.to_string());

        let config = SessionConfig {
            module_name: "App".to_string(),
            ui_source: r#"Icon(@resources.heart)"#.to_string(),
            components,
            initial_state: serde_json::json!({}),
            action_names: vec![],
            resources,
            modules: Vec::new(),
        };
        let session = RemoteSession::new(config);
        let msgs = session.handle_hello(None);

        // Must have sessionAck + initialTree
        assert_eq!(msgs.len(), 2, "expected ack + initialTree");
        let initial_tree = &msgs[1];

        // The Icon create patch must carry resolved icon data, not the raw
        // reference. `__iconPaths` is the engine's marker for a resolved icon.
        assert!(
            initial_tree.contains("__iconPaths"),
            "initialTree does not contain __iconPaths — resources did not reach the engine. \
             Payload: {}",
            initial_tree
        );
        assert!(
            initial_tree.contains(r#""d":"M12 21"#),
            "resolved heart path d did not round-trip into the patch stream: {}",
            initial_tree
        );
    }
}
