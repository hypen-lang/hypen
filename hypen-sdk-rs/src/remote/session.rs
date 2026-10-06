use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use hypen_engine::device::{
    device_message_type, is_oversize_device_text, negotiate_explained, top_level_member_text,
    BrokerConfig, DeviceBroker,
};
use hypen_engine::{Engine, Patch, TemplateExpander};
use serde_json::Value;

use crate::context::GlobalContext;
use crate::device::{
    Device, DeviceBinding, DeviceOwner, DevicePlane, DeviceServer, DeviceTransport, DispatchGuard,
    SessionTransport, StateApplier,
};
use crate::discovery::ComponentRegistry;
use crate::error::{Result, SdkError};
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
    /// The connection this session is served over. With it the device
    /// plane (RFC 001) is on: a client whose hello offers `device` gets
    /// one, with no further call. `None` (in-process / test sessions): the
    /// host only drains replies from `handle_message`, and the session is
    /// UI-only.
    pub transport: Option<Arc<dyn SessionTransport>>,
    /// The server-wide settings (device options, resume tokens, upload
    /// budget). `None` = [`DeviceServer::shared`].
    pub device_server: Option<Arc<DeviceServer>>,
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
            transport: None,
            device_server: None,
        }
    }
}

/// Type-erased action handler: `(action_name, payload, current_state) -> new_state`.
///
/// Wrapped in `Arc` so the same handler can be shared between the
/// `primary_handler` slot and the engine-side `on_action` placeholder
/// closures registered at session construction.
type ActionHandlerFn = Arc<dyn Fn(&str, Option<&Value>, &Value) -> Value + Send + Sync>;

/// A nested module's type-erased handler: like [`ActionHandlerFn`], plus the
/// session's [`GlobalContext`] (whose [`device`](GlobalContext::device) is
/// scoped to the invocation).
type ModuleHandlerFn =
    Arc<dyn Fn(&str, Option<&Value>, &Value, Option<&GlobalContext>) -> Value + Send + Sync>;

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
    pub(crate) action_handler: ModuleHandlerFn,
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
        let handler: ModuleHandlerFn = Arc::new(move |action, payload, state_json, ctx| {
            // `__hypen_bind` short-circuit: renderer-side two-way binding.
            // No user handler is registered for this name; we rewrite state
            // at the dotted path directly. Validates against `S` so a bind
            // to a non-existent field is silently dropped (matching TS/JS
            // proxy semantics). See ENGINE_CONTRACT.md §13.
            if matches!(action, "__hypen_reorder" | "__hypen_pin") {
                return crate::state::apply_dnd_to_json::<S>(state_json, action, payload)
                    .unwrap_or_else(|error| {
                        eprintln!("[Hypen] {error}");
                        state_json.clone()
                    });
            }
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

            let mut state: S = match crate::state::decode_state(state_json) {
                Ok(s) => s,
                Err(_) => return state_json.clone(),
            };
            // Remote sessions only run sync handlers — async handlers
            // would need an executor we don't own here.
            if let Some(ActionHandler::Sync(h)) = def.action_handlers.get(action) {
                h(&mut state, payload, ctx);
            }
            crate::state::encode_state(&state, state_json).unwrap_or_else(|_| state_json.clone())
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
    /// `Arc` so a device result settling later (on the socket reader or the
    /// device timer thread) can apply to this session through a `Weak`.
    inner: Arc<Mutex<SessionInner>>,
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
    /// The device plane (RFC 001) of this connection, as handlers see it.
    device_binding: Arc<DeviceBinding>,
    /// The connection's transport (`None`: in-process, UI-only).
    transport: Option<Arc<dyn SessionTransport>>,
    /// Server-wide settings: device options and opt-out, resume tokens
    /// (`None`: [`DeviceServer::shared`], resolved only when needed — see
    /// [`Self::server`]).
    device_server: Option<Arc<DeviceServer>>,
    /// This connection's device opt-out ([`Self::disable_device`]).
    device_disabled: AtomicBool,
    /// Route pattern → the registered module scope it shows, from the
    /// `Router { Route … }` blocks of the UI (navigation moves device
    /// activation between them).
    route_scopes: Arc<Vec<(String, String)>>,
    /// The routed module scope on screen now (`None`: the current route
    /// shows no registered module, or the UI has no `Router`).
    screen_scope: Arc<Mutex<Option<String>>>,
    /// The resume token the last `sessionAck` carried.
    resume_token: Mutex<Option<String>>,
}

/// The device route of a [`SessionTransport`], for the plane.
struct DeviceRoute(Arc<dyn SessionTransport>);

impl DeviceTransport for DeviceRoute {
    fn send_text(&self, text: String) {
        self.0.send_text(text)
    }
    fn send_binary(&self, frame: Vec<u8>) {
        self.0.send_binary(frame)
    }
    fn close(&self, code: u16, reason: &str) {
        self.0.close(code, reason)
    }
    fn buffered_bytes(&self) -> usize {
        self.0.buffered_bytes()
    }
}

/// The module scope a route pattern table shows for `path` (first match).
fn scope_for_path(routes: &[(String, String)], path: &str) -> Option<String> {
    routes
        .iter()
        .find(|(pattern, _)| hypen_engine::match_path(pattern, path).is_some())
        .map(|(_, scope)| scope.clone())
}

/// Route pattern → registered module scope, from every `Router { Route … }`
/// block in `sources` (outer blocks first; the first element of a route
/// body that is a registered module wins, like the other SDKs' auto-wired
/// routers).
fn discover_route_scopes<'a>(
    sources: impl IntoIterator<Item = &'a str>,
    scopes: &std::collections::HashSet<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for source in sources {
        // Only sources that can hold a Router are parsed (every connection
        // runs this).
        if !source.contains("Router") {
            continue;
        }
        let Ok(doc) = hypen_parser::parse_document(source) else {
            continue;
        };
        for component in &doc.components {
            let ir = hypen_engine::ir::ast_to_ir_node(component);
            for router in hypen_engine::ir::discover_routers(&ir) {
                for route in router.routes {
                    if out.iter().any(|(p, _)| *p == route.path) {
                        continue;
                    }
                    if let Some(scope) = route
                        .element_names
                        .iter()
                        .map(|n| n.to_lowercase())
                        .find(|n| scopes.contains(n))
                    {
                        out.push((route.path, scope));
                    }
                }
            }
        }
    }
    out
}

/// Numbers the device identities sessions assign to their modules.
static OWNER_SEQ: AtomicU64 = AtomicU64::new(0);

/// What a `hello` carried for the device plane.
#[derive(Default)]
struct HelloDevice {
    /// The exact `hello.device` JSON text (`None`: absent or ambiguous).
    raw: Option<String>,
    resume_token: Option<String>,
}

struct SessionInner {
    engine: Engine,
    ui_source: String,
    revision: u64,
    state_subscribed: bool,
    rendered: bool,
    /// The id this session acknowledged to its client in `sessionAck`.
    ///
    /// `None` until [`RemoteSession::handle_hello`] runs. When the client
    /// resumed a suspended session this is the id it presented, not the
    /// local `session_{nanos}` — so it is the id a peer (an agent, a REST
    /// route) would know the session by. See
    /// [`RemoteSession::acked_session_id`].
    acked_session_id: Option<String>,
    /// Remote clients are version-unknown peers: they must always see the
    /// plain `Create`+`Insert` wire, never `RegisterTemplate`/`Instantiate`.
    /// Session-lifetime state: skeletons registered by earlier batches
    /// expand later `Instantiate`s.
    template_expander: TemplateExpander,
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
            reg.get(name)
                .map(|entry| hypen_engine::ir::ResolvedComponent {
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
            let module_meta = hypen_engine::Module::new(name).with_actions(action_names.clone());
            let module_inst = hypen_engine::ModuleInstance::new(module_meta, initial_state.clone());
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
        let device_binding = Arc::new(DeviceBinding::default());
        let context = Arc::new(GlobalContext::new());
        for action_name in &config.action_names {
            let name = action_name.clone();
            let state_arc = Arc::clone(&state);
            let handler_arc = Arc::clone(&primary_handler);
            let binding = Arc::clone(&device_binding);
            let ctx = Arc::clone(&context);
            engine.on_action(
                hypen_engine::action_routing::scoped_action_name("", &name),
                move |action| {
                    let handler_guard = handler_arc.lock().unwrap();
                    let Some(handler) = handler_guard.as_ref() else {
                        return;
                    };
                    let mut state_guard = state_arc.lock().unwrap();
                    let current = state_guard.get("").cloned().unwrap_or(Value::Null);
                    // Device access scoped to this invocation (RFC 001 §4).
                    let new_state = ctx.with_device(binding.device_for(""), || {
                        handler(&name, action.payload.as_ref(), &current)
                    });
                    state_guard.insert(String::new(), new_state);
                },
            );
        }

        // Reserved writes need handlers even though they are not user-declared
        // actions. Primary and nested modules register separate scoped keys.
        for name in ["__hypen_bind", "__hypen_reorder", "__hypen_pin"] {
            let state_arc = Arc::clone(&state);
            let handler_arc = Arc::clone(&primary_handler);
            engine.on_action(
                hypen_engine::action_routing::scoped_action_name("", name),
                move |action| {
                    let handler_guard = handler_arc.lock().unwrap();
                    let Some(handler) = handler_guard.as_ref() else {
                        return;
                    };
                    let mut state_guard = state_arc.lock().unwrap();
                    let current = state_guard.get("").cloned().unwrap_or(Value::Null);
                    let new_state = handler(name, action.payload.as_ref(), &current);
                    state_guard.insert(String::new(), new_state);
                },
            );
        }

        // Per-session router + context. The router is driven both
        // internally (by the `router.*` engine action handlers
        // installed below) and externally (callers can subscribe via
        // `session.router().on_navigate(...)` or attach a
        // `ManagedRouter`).
        let router = Arc::new(HypenRouter::new());
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

        // Device activation follows the screen (RFC 001 §2.7): each
        // navigation — through `@router.*` or the host driving
        // `session.router()` (e.g. a ManagedRouter) — ends the activation
        // of the routed module scope that left the screen (its in-flight
        // activation-owned device work is cancelled) and starts a new one
        // for the scope that entered it.
        let known_scopes: std::collections::HashSet<String> = config
            .modules
            .iter()
            .map(|(name, _, _)| name.to_lowercase())
            .collect();
        let route_scopes = Arc::new(discover_route_scopes(
            std::iter::once(config.ui_source.as_str())
                .chain(registry.all().into_iter().map(|e| e.source.as_str())),
            &known_scopes,
        ));
        let screen_scope = Arc::new(Mutex::new(scope_for_path(
            &route_scopes,
            &router.current_path(),
        )));
        if !route_scopes.is_empty() {
            let weak_router = Arc::downgrade(&router);
            let routes = Arc::clone(&route_scopes);
            let screen = Arc::clone(&screen_scope);
            let binding = Arc::clone(&device_binding);
            router.on_navigate(move |_| {
                let Some(router) = weak_router.upgrade() else {
                    return;
                };
                let next = scope_for_path(&routes, &router.current_path());
                let prev = {
                    let mut current = screen.lock().unwrap();
                    if *current == next {
                        return;
                    }
                    std::mem::replace(&mut *current, next.clone())
                };
                if let Some(scope) = prev {
                    binding.deactivate(&scope);
                }
                if let Some(scope) = next {
                    binding.activate(&scope);
                }
            });
        }

        Self {
            inner: Arc::new(Mutex::new(SessionInner {
                engine,
                ui_source: config.ui_source,
                revision: 0,
                state_subscribed: false,
                rendered: false,
                acked_session_id: None,
                template_expander: TemplateExpander::new(),
            })),
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
            device_binding,
            transport: config.transport,
            device_server: config.device_server,
            device_disabled: AtomicBool::new(false),
            route_scopes,
            screen_scope,
            resume_token: Mutex::new(None),
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
        Self::build_from_definition(def, components, None, vec![], None)
    }

    /// Create the session for a client connection from a
    /// [`ModuleDefinition`]: [`from_definition`](Self::from_definition)
    /// plus the connection's [`SessionTransport`]. This is how a server
    /// builds its per-socket session: the device plane (RFC 001) is on — a
    /// client whose hello offers `device` gets one, with no further call —
    /// and every `sessionAck` carries a rotating `resumeToken`.
    ///
    /// Replies to the client's own messages still come back from
    /// [`handle_message_with`](Self::handle_message_with); `transport`
    /// carries what the session produces on its own (device requests,
    /// frames, patches from device results that settle later). Feed both
    /// into the connection's one ordered writer.
    ///
    /// ```rust,ignore
    /// let session = Arc::new(RemoteSession::connect(def, components, Arc::new(MyTransport(tx))));
    /// ```
    pub fn connect<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
        transport: Arc<dyn SessionTransport>,
    ) -> Self {
        Self::build_from_definition(def, components, None, vec![], Some(transport))
    }

    /// [`connect`](Self::connect) with a per-client state override and
    /// nested modules (see
    /// [`from_definition_with_state`](Self::from_definition_with_state)).
    pub fn connect_with_state<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
        initial_state: S,
        modules: Vec<ModuleSessionConfig>,
        transport: Arc<dyn SessionTransport>,
    ) -> Self {
        Self::build_from_definition(
            def,
            components,
            Some(initial_state),
            modules,
            Some(transport),
        )
    }

    /// Use `server`'s settings (device options and opt-out, resume tokens,
    /// upload budget) instead of [`DeviceServer::shared`]. Call it right
    /// after construction, before the hello.
    pub fn with_device_server(mut self, server: &Arc<DeviceServer>) -> Self {
        self.device_server = Some(Arc::clone(server));
        self
    }

    /// The server-wide settings this session uses: its own, else — for a
    /// session served over a connection — [`DeviceServer::shared`]. A
    /// session without a transport and without a server (in-process) has
    /// none: it keeps the legacy UI-only behaviour and never touches the
    /// process default.
    fn server(&self) -> Option<Arc<DeviceServer>> {
        match &self.device_server {
            Some(server) => Some(Arc::clone(server)),
            None if self.transport.is_some() => Some(DeviceServer::shared()),
            None => None,
        }
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
        Self::build_from_definition(def, components, Some(initial_state), modules, None)
    }

    /// Internal constructor shared by `from_definition` variants.
    fn build_from_definition<S: State>(
        def: Arc<ModuleDefinition<S>>,
        components: ComponentRegistry,
        state_override: Option<S>,
        modules: Vec<ModuleSessionConfig>,
        transport: Option<Arc<dyn SessionTransport>>,
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
            .map(|m| {
                (
                    m.name.clone(),
                    m.initial_state.clone(),
                    m.action_names.clone(),
                )
            })
            .collect();

        let config = SessionConfig {
            module_name: def.name.clone(),
            ui_source,
            components,
            initial_state: initial_state_json,
            action_names: def.action_names(),
            resources: def.resource_map.clone(),
            modules: raw_modules,
            transport,
            device_server: None,
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
        let bridge_ctx = Arc::clone(&session.context);
        session.set_action_handler(move |action, payload, state_json| {
            // `__hypen_bind` short-circuit — see the note in `Self::build`.
            if matches!(action, "__hypen_reorder" | "__hypen_pin") {
                return crate::state::apply_dnd_to_json::<S>(state_json, action, payload)
                    .unwrap_or_else(|error| {
                        eprintln!("[Hypen] {error}");
                        state_json.clone()
                    });
            }
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

            let mut state: S = match crate::state::decode_state(state_json) {
                Ok(s) => s,
                Err(_) => return state_json.clone(),
            };
            if let Some(ActionHandler::Sync(handler)) = def.action_handlers.get(action) {
                // The engine-side closure scoped `device()` to this call.
                handler(&mut state, payload, Some(&bridge_ctx));
            }
            crate::state::encode_state(&state, state_json).unwrap_or_else(|_| state_json.clone())
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
                for action_name in module_cfg.action_names.iter().map(String::as_str).chain([
                    "__hypen_bind",
                    "__hypen_reorder",
                    "__hypen_pin",
                ]) {
                    let action = action_name.to_string();
                    let scope = scope_key.clone();
                    let h = Arc::clone(&handler);
                    let state_arc = Arc::clone(&session.state);
                    let binding = Arc::clone(&session.device_binding);
                    let ctx = Arc::clone(&session.context);
                    inner.engine.on_action(
                        hypen_engine::action_routing::scoped_action_name(&scope, &action),
                        move |evt| {
                            let mut state_guard = state_arc.lock().unwrap();
                            let current = state_guard.get(&scope).cloned().unwrap_or(Value::Null);
                            let new_state = ctx.with_device(binding.device_for(&scope), || {
                                h(&action, evt.payload.as_ref(), &current, Some(&ctx))
                            });
                            state_guard.insert(scope.clone(), new_state);
                        },
                    );
                }
            }
        }

        // Build type-erased session lifecycle wrappers from the typed
        // definition handlers. Each wrapper deserializes the JSON state
        // into S, calls the typed handler, and serializes back.
        if def_for_disconnect.on_disconnect.is_some() {
            session.on_disconnect = Some(Box::new(move |state_json, session_info| {
                if let Some(ref handler) = def_for_disconnect.on_disconnect {
                    if let Ok(state) = crate::state::decode_state::<S>(state_json) {
                        handler(&state, session_info);
                    }
                }
            }));
        }
        if def_for_reconnect.on_reconnect.is_some() {
            session.on_reconnect = Some(Box::new(move |state_json, session_info, saved_state| {
                if let Some(ref handler) = def_for_reconnect.on_reconnect {
                    if let Ok(mut state) = crate::state::decode_state::<S>(state_json) {
                        handler(&mut state, session_info, saved_state);
                        if let Ok(new_json) = crate::state::encode_state(&state, state_json) {
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
    ///
    /// This is the id the session was *created* with. The id the client
    /// was actually told — which differs when the client resumed a
    /// suspended session by presenting its own — is
    /// [`acked_session_id`](Self::acked_session_id).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The id acknowledged to the client in `sessionAck`, or `None` before
    /// [`handle_hello`](Self::handle_hello) has run.
    ///
    /// This is the id an attached agent must use: it is what the client
    /// holds, so it is what the client can hand to a trusted backend. A
    /// [`SessionRegistry`](super::SessionRegistry) keys on it.
    pub fn acked_session_id(&self) -> Option<String> {
        self.inner.lock().unwrap().acked_session_id.clone()
    }

    /// Whether the hello handshake has completed — the UI has been rendered
    /// and the declaration tables ([`list_actions`](Self::list_actions),
    /// [`list_routes`](Self::list_routes), ...) are populated.
    ///
    /// Attach mode gates on this: a handle bound to a session that has not
    /// rendered yet would see an empty surface.
    pub fn hello_completed(&self) -> bool {
        self.inner.lock().unwrap().rendered
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
        let mut messages = Vec::with_capacity(2);
        self.hello_with(client_session_id, HelloDevice::default(), &mut |m| {
            messages.push(m.to_string())
        });
        self.drain_device_jobs();
        messages
    }

    /// Body of [`handle_hello`](Self::handle_hello): `emit` is called for
    /// each outbound message **while `inner` is still held**, so the
    /// messages reach the host's outbound queue in lock order relative to
    /// every other emission on this session (see
    /// [`handle_message_with`](Self::handle_message_with)).
    ///
    /// On a session with the device plane on (built for a connection with
    /// a transport — the default — and not disabled) this is also the
    /// device handshake (RFC 001 §2.2, §5): the hello's exact `device` text
    /// is negotiated through the shared Rust selection, the ack carries
    /// `device` and a fresh `resumeToken`, and the connection's broker
    /// opens `core.capabilities` right after the ack and the initial tree.
    /// A resume of a session that negotiated a device plane without its
    /// latest `resumeToken` becomes a **new** session; a UI-only session
    /// keeps the legacy id-only resume.
    fn hello_with(
        &self,
        client_session_id: Option<&str>,
        hello: HelloDevice,
        emit: &mut dyn FnMut(&str),
    ) {
        let _dispatch = DispatchGuard::enter();
        let mut inner = self.inner.lock().unwrap();

        let server = self.server();
        let setup = self.device_transport();
        // A session that negotiated a device plane resumes only with its
        // latest token; a missing or mismatched one starts a new session —
        // never an error, never a takeover of the live one (RFC 001 §5).
        // UI-only sessions keep the legacy id-only resume.
        let client_session_id = match (client_session_id, &server) {
            (Some(id), Some(server))
                if !server.resume_allowed(id, hello.resume_token.as_deref()) =>
            {
                log::info!("hypen device: resume of {id} without its token — new session");
                None
            }
            (id, _) => id,
        };
        let is_restored = client_session_id.is_some();

        // 1. sessionAck. Remember what we told the client — that is the id
        // an attached agent will present, so it must be the id we key on.
        let acked_id = client_session_id.unwrap_or(&self.session_id).to_string();
        let first_hello = inner.acked_session_id.is_none();
        inner.acked_session_id = Some(acked_id.clone());

        // The device selection: once per connection, from the exact
        // `hello.device` text (never repaired, D7).
        let ack = match (&setup, hello.raw.as_deref()) {
            (Some(_), Some(raw)) if first_hello && self.device_binding.plane().is_none() => {
                match negotiate_explained(raw, true, None) {
                    Ok(ack) => Some(ack),
                    Err(why) => {
                        log::info!("hypen device: device plane disabled: {why}");
                        None
                    }
                }
            }
            _ => None,
        };
        // The device plane on (`setup` implies a server): a fresh token in
        // every ack.
        let device_server = setup.as_ref().and(server.as_ref());
        let resume_token = device_server.and_then(|s| s.issue_token(&acked_id));
        *self.resume_token.lock().unwrap() = resume_token.clone();
        if let (Some(_), Some(s)) = (&ack, device_server) {
            // From now on this session resumes only with its token.
            s.mark_device_session(&acked_id);
        }

        let ack_msg = RemoteMessage::SessionAck {
            session_id: acked_id,
            is_new: !is_restored,
            is_restored,
            device: ack
                .as_ref()
                .map(|a| serde_json::to_value(a).expect("ack serializes")),
            resume_token,
        };
        if let Ok(json) = ack_msg.to_json() {
            emit(&json);
        }

        // 2. Render the UI (first time only) and capture patches. Lower
        // template patches before they cross the wire — remote clients of
        // any version must see plain patches.
        let patches = if !inner.rendered {
            inner.rendered = true;
            let ui = inner.ui_source.clone();
            let raw = render_and_capture(&mut inner.engine, &ui);
            inner.template_expander.expand(raw)
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
            emit(&json);
        }

        // 4. The device plane, after the ack that selects it: the broker
        // opens `core.capabilities` before any handler can request device
        // work, then every module this session runs gets its identity and
        // a first activation (routed modules off screen: when navigation
        // brings them on screen).
        if let (Some(ack), Some(transport), Some(server)) = (ack, setup, server) {
            let session = inner.acked_session_id.clone().unwrap_or_default();
            self.attach_plane(ack, &server, transport, &session);
        }
        // `inner` is released here, after the last `emit`.
    }

    /// The connection's transport when the device plane is on for this
    /// session: it has one, and neither the server nor the session opted
    /// out.
    fn device_transport(&self) -> Option<Arc<dyn SessionTransport>> {
        let transport = self.transport.clone()?;
        if self.device_disabled.load(Ordering::SeqCst)
            || !self.server().is_some_and(|s| s.device_enabled())
        {
            return None;
        }
        Some(transport)
    }

    fn attach_plane(
        &self,
        ack: hypen_engine::serialize::device::DeviceAck,
        server: &Arc<DeviceServer>,
        transport: Arc<dyn SessionTransport>,
        session: &str,
    ) {
        let cfg = server.device_options();
        let mut broker_cfg = BrokerConfig::new(ack);
        if let Some(n) = cfg.max_retained_bytes {
            broker_cfg.max_retained_bytes = n;
        }
        broker_cfg.max_item_bytes = cfg.max_item_bytes;
        broker_cfg.pool = Some(server.pool());
        let broker = DeviceBroker::new(broker_cfg, 0);
        let ui_sink: super::OutboundSink = {
            let transport = Arc::clone(&transport);
            Arc::new(move |m| transport.send_ui(m))
        };
        let plane = DevicePlane::new(broker, Arc::new(DeviceRoute(transport)), Instant::now());
        plane.set_applier(Arc::new(SessionApplier {
            inner: Arc::downgrade(&self.inner),
            state: Arc::downgrade(&self.state),
            module_name: self.module_name.clone(),
            ui_sink,
        }));
        if let Err(e) = plane.start() {
            log::warn!("hypen device: core.capabilities not opened ({e}) — device plane closed");
            plane.close();
            return;
        }
        let mut owners = HashMap::new();
        let scopes: Vec<String> = self.state.lock().unwrap().keys().cloned().collect();
        // A routed module that is not on screen right now starts inactive
        // (activation 0): it gets its first activation when navigation
        // brings it on screen, like every other SDK's routed modules.
        let on_screen = self.screen_scope.lock().unwrap().clone();
        for scope in scopes {
            let base = if scope.is_empty() {
                self.module_name.to_lowercase()
            } else {
                scope.clone()
            };
            let base: String = if base.is_empty() { "app".into() } else { base };
            let base: String = base.chars().take(160).collect();
            let off_screen = on_screen.as_deref() != Some(scope.as_str())
                && self.route_scopes.iter().any(|(_, s)| *s == scope);
            let owner = DeviceOwner {
                module_instance_id: format!(
                    "{base}@{}#{}",
                    session.chars().take(64).collect::<String>(),
                    OWNER_SEQ.fetch_add(1, Ordering::Relaxed) + 1
                ),
                activation_id: if off_screen { 0 } else { 1 },
            };
            if !off_screen {
                plane.owner_activated(&owner.module_instance_id, owner.activation_id);
            }
            owners.insert(scope, owner);
        }
        self.device_binding.attach(plane, owners);
        log::info!("hypen device: device plane enabled for session {session}");
    }

    // -----------------------------------------------------------------
    // Device plane (RFC 001)
    // -----------------------------------------------------------------

    /// Turn the device plane off for this connection — the per-session
    /// opt-out (for every session: [`DeviceServer::disable_device`]). The
    /// session then behaves exactly like a UI-only one: no device
    /// negotiation, no resume token. Call it before the hello.
    ///
    /// # Errors
    ///
    /// The hello already happened.
    pub fn disable_device(&self) -> Result<()> {
        if self.inner.lock().unwrap().acked_session_id.is_some() {
            return Err(SdkError::Other(
                "disable_device must be called before the hello".into(),
            ));
        }
        self.device_disabled.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Whether this connection negotiated a live device plane.
    pub fn device_enabled(&self) -> bool {
        self.device_binding.plane().is_some_and(|p| !p.is_closed())
    }

    /// The resume token the last `sessionAck` carried (sessions with the
    /// device plane on only).
    pub fn resume_token(&self) -> Option<String> {
        self.resume_token.lock().unwrap().clone()
    }

    /// Device access for `module` (`None` = the primary module) outside a
    /// handler — e.g. from a host-side task. Carries the module's live
    /// activation; results applied with `then` land in that module's state.
    pub fn device(&self, module: Option<&str>) -> Device {
        let scope = module.map(str::to_lowercase).unwrap_or_default();
        self.device_binding.device_for(&scope)
    }

    /// Feed a client → server binary WebSocket frame (RFC 001 §2.3). Without
    /// a device plane the frame is dropped (no storage is allocated).
    pub fn handle_binary(&self, frame: &[u8]) {
        if let Some(plane) = self.device_binding.plane() {
            plane.on_frame(frame);
            plane.drain_jobs();
        }
    }

    /// The connection closed: every live device operation settles
    /// `connectionLost` locally (nothing is sent) and the plane's timer
    /// stops. Call it from the socket task's exit path; dropping the
    /// session does the same.
    pub fn handle_close(&self) {
        if let Some(plane) = self.device_binding.take_plane() {
            plane.close();
        }
    }

    /// Device plane diagnostics: `(live requests incl. core.capabilities,
    /// retained upload bytes, connection-level violations)`.
    pub fn device_stats(&self) -> Option<(usize, u64, u64)> {
        self.device_binding.plane().map(|p| p.stats())
    }

    fn drain_device_jobs(&self) {
        if let Some(plane) = self.device_binding.plane() {
            plane.drain_jobs();
        }
    }

    /// Handle an incoming JSON message. Returns response messages as JSON strings.
    ///
    /// If anything other than this connection's own task can emit on the
    /// same transport — an attached [`AgentHandle`](super::AgentHandle) —
    /// use [`handle_message_with`](Self::handle_message_with) instead, so
    /// the replies are queued in revision order.
    pub fn handle_message(&self, json: &str) -> Vec<String> {
        let mut messages = Vec::new();
        self.handle_message_with(json, |m| messages.push(m.to_string()));
        messages
    }

    /// Handle an incoming JSON message, handing each reply to `emit`
    /// **while the session lock is still held**.
    ///
    /// This is the ordering guarantee attach mode relies on. A revision is
    /// assigned under the session's `inner` mutex; if the reply carrying it
    /// were queued only after the lock was released, another emitter on the
    /// same session (an attached agent's dispatch, or this task's next
    /// reply) could take revision N+1 and queue it first, and the client
    /// would drop revision N as out of order. Calling `emit` before the lock
    /// drops makes queue order equal lock order, so the single socket writer
    /// draining that queue always sees revisions ascending.
    ///
    /// `emit` must therefore be cheap and must not call back into this
    /// session (that would deadlock). An unbounded `mpsc` send is the
    /// intended shape. See [`handle_message`](Self::handle_message) for the
    /// collecting variant.
    ///
    /// Device messages (`deviceRequest` / `deviceResponse` / `deviceEvent`)
    /// go to the connection's device plane, never to the UI path; without a
    /// plane they are dropped.
    pub fn handle_message_with<F: FnMut(&str)>(&self, json: &str, mut emit: F) {
        self.dispatch_message(json, &mut emit);
        // Device results queued meanwhile (e.g. a refusal that settled
        // inside a handler) run now, outside the session lock.
        self.drain_device_jobs();
    }

    fn dispatch_message(&self, json: &str, emit: &mut dyn FnMut(&str)) {
        // The device plane first: over-limit text claiming a device type is
        // never parsed (RFC 001 §2.1), and device messages never reach the
        // UI message union.
        if is_oversize_device_text(json) || device_message_type(json).is_some() {
            if let Some(plane) = self.device_binding.plane() {
                plane.on_text(json);
            }
            return;
        }
        let msg = match RemoteMessage::from_json(json) {
            Ok(m) => m,
            // A hello whose only fault is a repeated `device` member is
            // still a hello: the ambiguous extension is dropped (the
            // connection stays UI-only), never guessed from.
            Err(_) => match Self::hello_without_device(json) {
                Some(m) => m,
                None => return,
            },
        };

        match msg {
            RemoteMessage::Hello {
                session_id,
                resume_token,
                ..
            } => {
                // The exact `hello.device` text: a duplicated member is
                // ambiguous and disables the device plane.
                let raw = match top_level_member_text(json, "device") {
                    Ok(raw) => raw.map(str::to_string),
                    Err(()) => {
                        log::info!("hypen device: ambiguous hello.device — device plane disabled");
                        None
                    }
                };
                self.hello_with(
                    session_id.as_deref(),
                    HelloDevice { raw, resume_token },
                    emit,
                )
            }

            RemoteMessage::DispatchAction {
                module,
                action,
                payload,
            } => {
                // A connection with the device plane on dispatches nothing
                // before its hello (RFC 001 §6 Phase S).
                if self.device_transport().is_some()
                    && self.inner.lock().unwrap().acked_session_id.is_none()
                {
                    log::debug!("hypen device: dispatch before hello dropped");
                    return;
                }
                self.handle_action(&module, &action, payload.as_ref(), emit)
            }

            RemoteMessage::SubscribeState { .. } => {
                self.inner.lock().unwrap().state_subscribed = true;
            }

            _ => {}
        }
    }

    /// A `hello` that fails typed decoding only because of its `device`
    /// member (e.g. repeated), parsed without it.
    fn hello_without_device(json: &str) -> Option<RemoteMessage> {
        let mut v: Value = serde_json::from_str(json).ok()?;
        if v.get("type")?.as_str()? != "hello" {
            return None;
        }
        v.as_object_mut()?.remove("device");
        serde_json::from_value(v).ok()
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
        emit: &mut dyn FnMut(&str),
    ) {
        // Invalid or stale UI ownership is refused before host mutation.
        let _ = self.run_action(action, payload, false, emit);
    }

    /// Dispatch an action on behalf of a caller that is not the rendered UI.
    ///
    /// Routes through the engine's guard, which accepts only what
    /// [`list_actions`](Self::list_actions) advertises: module-declared
    /// actions, [`NAVIGATE`](hypen_engine::NAVIGATE) /
    /// [`BACK`](hypen_engine::BACK) while the UI declares a `Router`, and
    /// [`SET_INPUT`](hypen_engine::SET_INPUT) for a field some `.bind()`
    /// declared. The reserved names a renderer legitimately uses
    /// (`__hypen_bind`, `router.replace`, `router.forward`) are refused.
    ///
    /// Returns the same messages [`handle_message`](Self::handle_message)
    /// would produce for the dispatch, so a non-UI transport can forward
    /// them to whatever clients are attached. When the messages are bound
    /// for a transport that this session's own task also writes to, use
    /// [`dispatch_external_with`](Self::dispatch_external_with) so they are
    /// queued in revision order.
    ///
    /// # Errors
    ///
    /// [`SdkError::Engine`] when the guard refuses the name or the
    /// `set_input` payload.
    pub fn dispatch_external(&self, action: &str, payload: Option<&Value>) -> Result<Vec<String>> {
        self.dispatch_external_with(action, payload, |_| {})
    }

    /// [`dispatch_external`](Self::dispatch_external), additionally handing
    /// each resulting message to `emit` **while the session lock is still
    /// held** — the same guarantee, for the same reason, as
    /// [`handle_message_with`](Self::handle_message_with). The messages are
    /// also returned, so the caller can relay them elsewhere; they have
    /// already been passed to `emit` by then.
    ///
    /// A guard refusal returns `Err` before `emit` is ever called: no
    /// traffic, no revision bump. `emit` must not call back into this
    /// session.
    pub fn dispatch_external_with<F: FnMut(&str)>(
        &self,
        action: &str,
        payload: Option<&Value>,
        mut emit: F,
    ) -> Result<Vec<String>> {
        let mut messages = Vec::new();
        let r = self.run_action(action, payload, true, &mut |m| {
            emit(m);
            messages.push(m.to_string());
        });
        self.drain_device_jobs();
        r?;
        Ok(messages)
    }

    /// Shared body of [`handle_action`](Self::handle_action) and
    /// [`dispatch_external`](Self::dispatch_external). `external` picks the
    /// guarded entry point; everything after the dispatch — state diffing,
    /// patch capture, revision bump — is identical, which is the point:
    /// an external caller's effects reach clients exactly like a click's.
    ///
    /// Every outbound message goes to `emit` before `inner` is released, so
    /// the order in which messages reach the host's queue is the order in
    /// which their revisions were assigned.
    fn run_action(
        &self,
        action: &str,
        payload: Option<&Value>,
        external: bool,
        emit: &mut dyn FnMut(&str),
    ) -> Result<()> {
        let _dispatch = DispatchGuard::enter();
        let mut inner = self.inner.lock().unwrap();
        // The replay firewall (RFC 001 §1.7): a dispatch that is not the
        // user's own click (an attached agent's) never acquires device
        // authority; the flag rides every `Device` handed out meanwhile.
        self.device_binding.set_replayed(external);
        struct ClearReplay<'a>(&'a DeviceBinding);
        impl Drop for ClearReplay<'_> {
            fn drop(&mut self) {
                self.0.set_replayed(false);
            }
        }
        let _clear = ClearReplay(&self.device_binding);

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
        // A refusal from the guard is the caller's error, not a state
        // change; parked here because `with_capture` hands back patches,
        // not results.
        let mut refusal: Option<SdkError> = None;
        let patches = with_capture(&mut inner.engine, |engine| {
            // Run the engine-side handler. Errors on the renderer path mean
            // no handler is registered (e.g. unknown action) — we still
            // proceed to push any changed scopes below so the engine sees a
            // consistent revision.
            if external {
                if let Err(e) = engine.dispatch_external(action_obj) {
                    refusal = Some(SdkError::Engine(e));
                    return;
                }
            } else {
                let _ = engine.dispatch_action(action_obj);
            }
            push_changed_scopes(engine, &state_arc, &pre);
        });
        if let Some(err) = refusal {
            // Nothing ran, so there is nothing to report and no revision to
            // bump — the session is exactly as the caller found it.
            return Err(err);
        }

        finish_revision(&mut inner, patches, &self.module_name, &self.state, emit);

        // `inner` is released here, after the last `emit`.
        Ok(())
    }

    // -----------------------------------------------------------------
    // External capability surface
    //
    // For callers that are not the rendered UI — an MCP server, a REST
    // endpoint, a CLI, an agent. Each list is an allowlist the engine
    // derives from what the developer declared (`.on_action(...)`,
    // `Router { Route }`, `.bind(@state.x)`), and `dispatch_external`
    // admits exactly what the lists advertise. See `hypen_engine::agent`.
    // -----------------------------------------------------------------

    /// Every action an external caller may dispatch right now, across the
    /// primary module and every module registered with the session.
    pub fn list_actions(&self) -> Vec<hypen_engine::AgentAction> {
        self.inner.lock().unwrap().engine.list_actions()
    }

    /// The MCP handshake for this session's app, composed by the engine from
    /// the same declaration tables [`list_actions`](Self::list_actions) reads.
    /// Copy its fields through verbatim — see
    /// [`Engine::mcp_manifest`](hypen_engine::Engine::mcp_manifest).
    pub fn mcp_manifest(&self) -> hypen_engine::agent::McpManifest {
        self.inner.lock().unwrap().engine.mcp_manifest()
    }

    /// Every route the session's UI declares, in declaration order.
    ///
    /// Empty until [`handle_hello`](Self::handle_hello) has rendered — the
    /// route table is read from the expanded IR.
    pub fn list_routes(&self) -> Vec<hypen_engine::AgentRoute> {
        self.inner.lock().unwrap().engine.list_routes()
    }

    /// Every `.bind()`-declared writable input — the only fields
    /// [`SET_INPUT`](hypen_engine::SET_INPUT) will accept. Empty until the
    /// first render, for the same reason as [`list_routes`](Self::list_routes).
    pub fn list_bindings(&self) -> Vec<hypen_engine::BoundInput> {
        self.inner.lock().unwrap().engine.list_bindings()
    }

    /// Read module state, whole or at a dotted path. `module` is `None` for
    /// the primary module, or the name of one passed in
    /// [`SessionConfig::modules`].
    ///
    /// `None` back means "unknown module *or* absent path" — deliberately
    /// not distinguished, so a caller can't probe for state it isn't shown.
    pub fn get_state_at(&self, module: Option<&str>, path: Option<&str>) -> Option<Value> {
        self.inner.lock().unwrap().engine.get_state(module, path)
    }

    /// Drop a registered module and every action it declared.
    ///
    /// **Destroy only.** A module that is merely off-screen stays registered
    /// on purpose — under `persist` the
    /// [`ManagedRouter`](crate::managed_router::ManagedRouter) keeps it so
    /// siblings can still read its state — so calling this on unmount would
    /// break the persist cache and cross-module reads.
    ///
    /// Only reaches modules registered by name (via
    /// [`SessionConfig::modules`]); the primary module lives in the engine's
    /// own slot and is replaced, not unregistered.
    pub fn unregister_module(&self, name: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.engine.unregister_module(name);
        drop(inner);
        self.state.lock().unwrap().remove(&name.to_lowercase());
        // Destruction sweeps the module's device work (RFC 001 §2.7).
        self.device_binding.destroy(&name.to_lowercase());
    }

    /// The module (`None` = primary) left the screen: its activation-owned
    /// device work is cancelled, and devices handed out during that
    /// activation are refused from now on (RFC 001 §2.7). Background work
    /// survives. Pair with [`Self::activate_module`].
    ///
    /// Navigation does this on its own for the modules the UI's
    /// `Router { Route … }` blocks show (through `@router.*` or the host
    /// driving [`Self::router`], e.g. a ManagedRouter): the module leaving
    /// the screen is deactivated and the one entering it activated. Call it
    /// yourself only for screens the session cannot see.
    pub fn deactivate_module(&self, module: Option<&str>) {
        self.device_binding
            .deactivate(&module.map(str::to_lowercase).unwrap_or_default());
    }

    /// The module (`None` = primary) became visible again: a new
    /// activation starts (reactivation never revives the old one's work).
    pub fn activate_module(&self, module: Option<&str>) {
        self.device_binding
            .activate(&module.map(str::to_lowercase).unwrap_or_default());
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

/// Diff the state map against the pre-dispatch snapshot and push every
/// scope whose value changed. `""` is the primary slot (passed as `None`);
/// every other key is a nested module's lowercased name.
fn push_changed_scopes(
    engine: &mut Engine,
    state: &Mutex<HashMap<String, Value>>,
    pre: &HashMap<String, Value>,
) {
    let post = state.lock().unwrap().clone();
    for (key, new_state) in &post {
        if pre.get(key) != Some(new_state) {
            let scope_opt = if key.is_empty() {
                None
            } else {
                Some(key.as_str())
            };
            engine.update_state(scope_opt, new_state.clone());
        }
    }
}

/// Lower template patches, bump the revision and emit the `patch` (and,
/// when subscribed, `stateUpdate`) messages of one state change. Called
/// with `inner` held, so revisions reach the host's queue in order.
fn finish_revision(
    inner: &mut SessionInner,
    patches: Vec<Patch>,
    module_name: &str,
    state: &Mutex<HashMap<String, Value>>,
    emit: &mut dyn FnMut(&str),
) {
    // Lower template patches before they cross the wire — remote
    // clients of any version must see plain patches.
    let patches = inner.template_expander.expand(patches);

    inner.revision += 1;

    if !patches.is_empty() {
        let patch_msg = RemoteMessage::Patch {
            module: module_name.to_string(),
            patches,
            revision: inner.revision,
        };
        if let Ok(json) = patch_msg.to_json() {
            emit(&json);
        }
    }

    if inner.state_subscribed {
        // Read the primary state for the StateUpdate message — even when
        // the action targeted a nested module, the wire protocol's
        // StateUpdate is keyed to the primary module name.
        let primary_state = state
            .lock()
            .unwrap()
            .get("")
            .cloned()
            .unwrap_or(Value::Null);
        let state_msg = RemoteMessage::StateUpdate {
            module: module_name.to_string(),
            state: primary_state,
            revision: inner.revision,
        };
        if let Ok(json) = state_msg.to_json() {
            emit(&json);
        }
    }
}

/// Applies settled device results to a session's module state (RFC 001 §4:
/// "validate results before handlers see them" — the broker did; this ships
/// the resulting patches like an action's).
struct SessionApplier {
    inner: Weak<Mutex<SessionInner>>,
    state: Weak<Mutex<HashMap<String, Value>>>,
    module_name: String,
    ui_sink: super::OutboundSink,
}

impl StateApplier for SessionApplier {
    fn apply(&self, scope: &str, f: &mut dyn FnMut(&mut Value)) -> bool {
        let (Some(inner), Some(state)) = (self.inner.upgrade(), self.state.upgrade()) else {
            return false;
        };
        let _dispatch = DispatchGuard::enter();
        let mut inner = inner.lock().unwrap();
        let pre: HashMap<String, Value> = state.lock().unwrap().clone();
        {
            let mut st = state.lock().unwrap();
            let Some(slot) = st.get_mut(scope) else {
                return true; // the module was unregistered meanwhile
            };
            f(slot);
        }
        let patches = with_capture(&mut inner.engine, |engine| {
            push_changed_scopes(engine, &state, &pre);
        });
        let sink = &self.ui_sink;
        finish_revision(&mut inner, patches, &self.module_name, &state, &mut |m| {
            sink(m.to_string())
        });
        true
    }
}

impl Drop for RemoteSession {
    fn drop(&mut self) {
        self.handle_close();
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
        components.register("Greeting", r#"Text("Hello @{state.name}")"#, None);

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
            ..SessionConfig::default()
        }
    }

    #[test]
    fn reserved_pin_survives_remote_typed_roundtrip() {
        use serde::{Deserialize, Serialize};
        use serde_json::json;
        #[derive(Clone, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Board {
            count: u32,
        }
        let def = Arc::new(
            crate::module::ModuleBuilder::new("Board")
                .state(Board { count: 0 })
                .ui("Text(\"@{state.count}\")")
                .on_action::<()>("increment", |s, _, _| s.count += 1)
                .build(),
        );
        let session = RemoteSession::from_definition(def, ComponentRegistry::new());
        session.handle_hello(None);
        session.handle_message(&json!({"type":"dispatchAction","module":"Board","action":"__hypen_pin","payload":{"path":"__dnd.board.a","x":0.5,"y":0.25,"xKey":"left","yKey":"top"}}).to_string());
        session
            .handle_message(r#"{"type":"dispatchAction","module":"Board","action":"increment"}"#);
        assert_eq!(
            session.get_state(),
            json!({"count":1,"__dnd":{"board":{"a":{"left":0.5,"top":0.25}}}})
        );
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

    // -----------------------------------------------------------------
    // External capability surface
    // -----------------------------------------------------------------

    /// A session whose UI declares a `Router`, so navigation is on offer.
    fn routed_config() -> SessionConfig {
        SessionConfig {
            module_name: "App".to_string(),
            ui_source: r#"
                Column {
                    Router {
                        Route(path: "/") { Text("home") }
                        Route(path: "/search/:query") { Text("results") }
                    }
                }
            "#
            .to_string(),
            ..SessionConfig::default()
        }
    }

    #[test]
    fn test_external_navigate_drives_the_session_router() {
        let session = RemoteSession::new(routed_config());
        let _ = session.handle_hello(None);

        let routes = session.list_routes();
        assert_eq!(routes.len(), 2, "declared routes: {routes:?}");
        assert_eq!(routes[1].params, vec!["query".to_string()]);

        session
            .dispatch_external(
                hypen_engine::NAVIGATE,
                Some(&serde_json::json!({"to": "/search/rust"})),
            )
            .expect("navigate is offered once a Router is declared");

        assert_eq!(session.router().current_path(), "/search/rust");
    }

    #[test]
    fn test_external_navigate_refused_without_router() {
        let session = RemoteSession::new(test_config());
        let _ = session.handle_hello(None);

        assert!(session.list_routes().is_empty());
        assert!(session
            .dispatch_external(hypen_engine::NAVIGATE, None)
            .is_err());
    }

    #[test]
    fn test_external_refuses_framework_internals_by_name() {
        let session = RemoteSession::new(routed_config());
        let _ = session.handle_hello(None);

        // `router.push` backs the offered `navigate`; naming it directly is
        // still refused, as are the verbs that are never offered at all.
        for name in [
            "router.push",
            "router.replace",
            "router.forward",
            "__hypen_bind",
        ] {
            assert!(
                session.dispatch_external(name, None).is_err(),
                "{name} must not be externally dispatchable"
            );
        }
    }

    /// Destroying a module takes its actions off the external surface;
    /// a module that is merely off-screen keeps them, because siblings may
    /// still be reading its state.
    ///
    /// Built from typed definitions so every nested action has a handler
    /// installed: the engine only advertises actions that can actually be
    /// dispatched (a declared name with no handler is not listed), and the
    /// raw `SessionConfig.modules` path declares names without handlers.
    #[test]
    fn test_unregister_module_drops_only_that_modules_actions() {
        use crate::app::HypenApp;
        use serde::{Deserialize, Serialize};

        #[derive(Clone, Default, Serialize, Deserialize)]
        struct AppState {
            tick: u32,
        }
        #[derive(Clone, Default, Serialize, Deserialize)]
        struct SearchState {
            query: String,
        }
        #[derive(Clone, Default, Serialize, Deserialize)]
        struct CartState {
            items: Vec<String>,
        }

        let app = Arc::new(
            HypenApp::module::<AppState>("App")
                .state(AppState::default())
                .ui(r#"Column { Text("hi") }"#)
                .on_action::<()>("refresh", |s, _, _| s.tick += 1)
                .build(),
        );
        let search = Arc::new(
            HypenApp::module::<SearchState>("Search")
                .state(SearchState::default())
                .on_action::<()>("runSearch", |s, _, _| s.query = "ran".into())
                .build(),
        );
        let cart = Arc::new(
            HypenApp::module::<CartState>("Cart")
                .state(CartState::default())
                .on_action::<()>("addToCart", |s, _, _| s.items.push("x".into()))
                .build(),
        );
        let session = RemoteSession::from_definition_with_state(
            app,
            ComponentRegistry::new(),
            AppState::default(),
            vec![
                ModuleSessionConfig::from_definition(search),
                ModuleSessionConfig::from_definition(cart),
            ],
        );
        let _ = session.handle_hello(None);

        let names = |s: &RemoteSession| -> Vec<String> {
            s.list_actions().into_iter().map(|a| a.name).collect()
        };
        assert!(names(&session).contains(&"runSearch".to_string()));

        session.unregister_module("Search");

        let after = names(&session);
        assert!(
            !after.contains(&"runSearch".to_string()),
            "destroyed module's actions must leave the surface: {after:?}"
        );
        assert!(
            after.contains(&"addToCart".to_string()),
            "an off-screen module keeps its actions: {after:?}"
        );
        assert!(after.contains(&"refresh".to_string()));
        assert!(session.get_state_at(Some("Search"), None).is_none());
        assert!(session.get_state_at(Some("Cart"), None).is_some());
    }

    // -----------------------------------------------------------------
    // Attach mode
    // -----------------------------------------------------------------

    use super::super::agent::{AgentHandle, OutboundSink, SessionRegistry};

    /// A session whose `increment` action bumps `count`, wrapped in the
    /// `Arc` a host would hold. Hello has NOT run yet.
    fn counting_session() -> Arc<RemoteSession> {
        let session = RemoteSession::new(test_config());
        session.set_action_handler(|action, _payload, state| {
            let mut s = state.clone();
            if action == "increment" {
                if let Some(count) = s.get("count").and_then(|v| v.as_i64()) {
                    s["count"] = serde_json::json!(count + 1);
                }
            }
            s
        });
        Arc::new(session)
    }

    /// A sink that records every message it is handed.
    fn recording_sink() -> (OutboundSink, Arc<Mutex<Vec<String>>>) {
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_target = Arc::clone(&received);
        let sink: OutboundSink = Arc::new(move |msg| sink_target.lock().unwrap().push(msg));
        (sink, received)
    }

    /// Both a host task and an attached agent hold these across threads.
    #[test]
    fn assert_session_registry_and_handle_are_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RemoteSession>();
        assert_send_sync::<SessionRegistry>();
        assert_send_sync::<AgentHandle>();
    }

    #[test]
    fn test_hello_records_acked_session_id() {
        let session = counting_session();
        assert_eq!(session.acked_session_id(), None);
        assert!(!session.hello_completed());

        let _ = session.handle_hello(None);
        assert_eq!(
            session.acked_session_id().as_deref(),
            Some(session.session_id())
        );
        assert!(session.hello_completed());

        // A resumed client is acked under the id it presented, and that is
        // the id an agent must attach with.
        let resumed = counting_session();
        let msgs = resumed.handle_hello(Some("session_from_before"));
        assert!(msgs[0].contains(r#""sessionId":"session_from_before""#));
        assert_eq!(
            resumed.acked_session_id().as_deref(),
            Some("session_from_before")
        );
        assert_ne!(
            resumed.acked_session_id().as_deref(),
            Some(resumed.session_id())
        );
    }

    #[test]
    fn test_register_is_none_until_hello_completes() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let (sink, _) = recording_sink();

        assert_eq!(
            registry.register(&session, Arc::clone(&sink)).unwrap(),
            None
        );
        assert!(registry.is_empty());

        let _ = session.handle_message(r#"{"type":"hello"}"#);
        let id = registry
            .register(&session, sink)
            .unwrap()
            .expect("registered after hello");
        assert_eq!(id, session.session_id());
        assert_eq!(registry.len(), 1);
        assert!(registry.attach(&id).is_some());
    }

    #[test]
    fn test_attach_unknown_id_is_none() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, _) = recording_sink();
        registry.register(&session, sink).unwrap().unwrap();

        assert!(registry.attach("session_nobody").is_none());
        assert!(registry.attach("").is_none());
    }

    /// The headline: an attached dispatch runs on the user's engine, the
    /// user's transport receives exactly the returned wire messages, and
    /// the session's state and revision moved like a click's would.
    #[test]
    fn test_attach_dispatch_reaches_sink_and_updates_state() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, received) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();

        let handle = registry.attach(&id).expect("live session attaches");
        assert_eq!(handle.session_id(), id);
        assert_eq!(handle.revision().unwrap(), 0);
        assert!(handle
            .list_actions()
            .unwrap()
            .iter()
            .any(|a| a.name == "increment"));

        let messages = handle.dispatch("increment", None).expect("declared action");

        assert_eq!(
            *received.lock().unwrap(),
            messages,
            "sink gets the returned messages"
        );
        assert_eq!(
            messages.len(),
            1,
            "one patch, no stateUpdate (not subscribed)"
        );
        assert!(messages[0].contains(r#""type":"patch""#), "{}", messages[0]);
        assert!(messages[0].contains(r#""revision":1"#), "{}", messages[0]);
        assert!(messages[0].contains("Count: 1"), "{}", messages[0]);

        assert_eq!(session.get_state()["count"], 1);
        assert_eq!(session.revision(), 1);
        assert_eq!(handle.revision().unwrap(), 1);
        assert_eq!(
            handle.get_state(None, Some("count")).unwrap(),
            Some(serde_json::json!(1))
        );
    }

    /// Wire-identical: the bytes an attached dispatch puts on the user's
    /// transport are the bytes a `dispatchAction` from the renderer would.
    #[test]
    fn test_attach_dispatch_is_wire_identical_to_a_click() {
        let clicked = counting_session();
        let _ = clicked.handle_hello(None);
        let _ = clicked.handle_message(r#"{"type":"subscribeState","module":"App"}"#);
        let via_click = clicked
            .handle_message(r#"{"type":"dispatchAction","module":"App","action":"increment"}"#);

        let registry = SessionRegistry::new();
        let attached = counting_session();
        let _ = attached.handle_hello(None);
        let _ = attached.handle_message(r#"{"type":"subscribeState","module":"App"}"#);
        let (sink, received) = recording_sink();
        let id = registry.register(&attached, sink).unwrap().unwrap();
        let via_agent = registry
            .attach(&id)
            .unwrap()
            .dispatch("increment", None)
            .unwrap();

        assert_eq!(via_click.len(), 2, "patch + stateUpdate: {via_click:?}");
        assert_eq!(via_agent, via_click);
        assert_eq!(*received.lock().unwrap(), via_click);
        assert_eq!(attached.revision(), clicked.revision());
    }

    /// A guard refusal is silent: `Err` back to the agent, nothing on the
    /// user's transport, revision and state untouched.
    #[test]
    fn test_attach_refusal_emits_nothing_and_bumps_nothing() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, received) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();

        for name in [
            "__hypen_bind",
            "router.push",
            "notDeclared",
            hypen_engine::NAVIGATE,
        ] {
            let err = handle
                .dispatch(name, Some(&serde_json::json!({"to": "/x"})))
                .expect_err(name);
            assert!(matches!(err, SdkError::Engine(_)), "{name}: {err}");
        }

        assert!(received.lock().unwrap().is_empty(), "no traffic on refusal");
        assert_eq!(session.revision(), 0);
        assert_eq!(handle.revision().unwrap(), 0);
        assert_eq!(session.get_state()["count"], 0);
    }

    /// Reads are gated exactly as on the session: undeclared paths and
    /// unknown modules are `None`, not an error.
    #[test]
    fn test_attach_get_state_is_gated_like_the_session() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, _) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();

        // `name` is in state but the UI never renders it.
        assert_eq!(handle.get_state(None, Some("name")).unwrap(), None);
        assert_eq!(handle.get_state(Some("Nope"), None).unwrap(), None);
        assert_eq!(
            handle.get_state(None, Some("count")).unwrap(),
            session.get_state_at(None, Some("count"))
        );
    }

    #[test]
    fn test_attach_manifest_passes_through() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, _) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();

        let manifest = handle.manifest().unwrap();
        assert_eq!(manifest, session.mcp_manifest());
        assert!(
            manifest.tools.iter().any(|t| t.name == "increment"),
            "{:?}",
            manifest.tools
        );
    }

    /// The registry and the handle hold `Weak` only. Dropping the host's
    /// `Arc` is the end of the session: the handle reports `SessionGone`
    /// on every call and the registry prunes the entry.
    #[test]
    fn test_dropped_session_is_session_gone_and_pruned() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, received) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();

        // The registry did not extend the session's life.
        assert_eq!(Arc::strong_count(&session), 1);
        drop(session);

        let gone = |r: Result<()>| {
            assert!(
                matches!(&r, Err(SdkError::SessionGone(s)) if s == &id),
                "{r:?}"
            );
        };
        gone(handle.dispatch("increment", None).map(|_| ()));
        gone(handle.list_actions().map(|_| ()));
        gone(handle.get_state(None, Some("count")).map(|_| ()));
        gone(handle.revision().map(|_| ()));
        gone(handle.manifest().map(|_| ()));
        assert!(received.lock().unwrap().is_empty());

        assert!(registry.attach(&id).is_none());
        assert!(registry.is_empty(), "dead entry pruned");
    }

    /// `unregister` drops the record only; the session is untouched and a
    /// handle taken earlier keeps working while the host holds the `Arc`.
    #[test]
    fn test_unregister_drops_record_not_session() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, received) = recording_sink();
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();

        assert!(registry.unregister(&session));
        assert!(!registry.unregister(&session));
        assert!(registry.attach(&id).is_none());

        // Session still alive and still serving its own client.
        assert!(session.hello_completed());
        let via_click = session
            .handle_message(r#"{"type":"dispatchAction","module":"App","action":"increment"}"#);
        assert_eq!(via_click.len(), 1);
        assert_eq!(session.get_state()["count"], 1);

        // The earlier handle still reaches it — its sink is whatever it
        // was registered with, so the record's removal is not a kill.
        handle.dispatch("increment", None).unwrap();
        assert_eq!(session.get_state()["count"], 2);
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    /// Re-registering the same id (a reconnect) swaps the sink; the
    /// host's later handle sees the new one.
    #[test]
    fn test_reregister_replaces_sink() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (old_sink, old_received) = recording_sink();
        let (new_sink, new_received) = recording_sink();
        let id = registry.register(&session, old_sink).unwrap().unwrap();
        assert_eq!(
            registry.register(&session, new_sink).unwrap().as_deref(),
            Some(id.as_str())
        );
        assert_eq!(registry.len(), 1);

        registry
            .attach(&id)
            .unwrap()
            .dispatch("increment", None)
            .unwrap();
        assert!(old_received.lock().unwrap().is_empty());
        assert_eq!(new_received.lock().unwrap().len(), 1);
    }

    /// A peer presenting another live session's id in its hello is acked
    /// under that id (that is how resume works), but the registry must not
    /// let it displace the session that legitimately holds the record:
    /// `register` refuses, `attach` keeps driving the original, and the
    /// impostor's teardown cannot make the original unattachable.
    #[test]
    fn test_register_refuses_id_of_a_different_live_session() {
        let registry = SessionRegistry::new();
        let a = counting_session();
        let _ = a.handle_message(r#"{"type":"hello"}"#);
        let (sink_a, received_a) = recording_sink();
        let id = registry.register(&a, sink_a).unwrap().unwrap();

        let b = counting_session();
        let acks = b.handle_message(&format!(r#"{{"type":"hello","sessionId":"{id}"}}"#));
        assert!(
            acks[0].contains(&format!(r#""sessionId":"{id}""#)),
            "{}",
            acks[0]
        );
        assert_eq!(b.acked_session_id().as_deref(), Some(id.as_str()));
        let (sink_b, received_b) = recording_sink();

        let err = registry
            .register(&b, Arc::clone(&sink_b))
            .expect_err("a live peer holds the id");
        assert!(
            matches!(&err, SdkError::SessionIdTaken(s) if s == &id),
            "{err}"
        );
        assert_eq!(registry.len(), 1);

        // The record still points at A: the agent drives A, not B.
        registry
            .attach(&id)
            .expect("A stays attachable")
            .dispatch("increment", None)
            .unwrap();
        assert_eq!(a.get_state()["count"], 1);
        assert_eq!(b.get_state()["count"], 0);
        assert_eq!(received_a.lock().unwrap().len(), 1);
        assert!(received_b.lock().unwrap().is_empty());

        // B's connection ends: its unregister is a no-op for A's record.
        assert!(!registry.unregister(&b));
        assert!(registry.attach(&id).is_some());
        assert_eq!(registry.len(), 1);

        // Once A is really gone, the id is free and B registers under it —
        // a reconnect after the stale connection was noticed.
        assert!(registry.unregister(&a));
        drop(a);
        assert_eq!(
            registry.register(&b, sink_b).unwrap().as_deref(),
            Some(id.as_str())
        );
        registry
            .attach(&id)
            .unwrap()
            .dispatch("increment", None)
            .unwrap();
        assert_eq!(b.get_state()["count"], 1);
        assert_eq!(received_b.lock().unwrap().len(), 1);
    }

    /// A record whose session has been dropped (a resume through
    /// `SessionManager` creates a new session object under the same id) is
    /// replaced, not refused.
    #[test]
    fn test_register_replaces_record_of_a_dropped_session() {
        let registry = SessionRegistry::new();
        let old = counting_session();
        let _ = old.handle_hello(Some("session_resumed"));
        let (old_sink, _) = recording_sink();
        registry.register(&old, old_sink).unwrap().unwrap();
        drop(old);

        let new = counting_session();
        let _ = new.handle_hello(Some("session_resumed"));
        let (new_sink, new_received) = recording_sink();
        assert_eq!(
            registry.register(&new, new_sink).unwrap().as_deref(),
            Some("session_resumed")
        );
        registry
            .attach("session_resumed")
            .unwrap()
            .dispatch("increment", None)
            .unwrap();
        assert_eq!(new.get_state()["count"], 1);
        assert_eq!(new_received.lock().unwrap().len(), 1);
    }

    /// If a session re-acks under a different id mid-connection, the old
    /// key stops attaching (the session no longer "has" that id), and
    /// re-registering moves the one record to the new key rather than
    /// leaving two.
    #[test]
    fn test_rehello_with_new_id_moves_the_record() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let (sink, _) = recording_sink();
        let first = registry
            .register(&session, Arc::clone(&sink))
            .unwrap()
            .unwrap();
        assert!(registry.attach(&first).is_some());

        let _ = session.handle_message(r#"{"type":"hello","sessionId":"session_renamed"}"#);
        assert!(
            registry.attach(&first).is_none(),
            "stale key must not bind to a session acked under another id"
        );
        assert!(
            registry.attach("session_renamed").is_none(),
            "not registered yet"
        );

        assert_eq!(
            registry.register(&session, sink).unwrap().as_deref(),
            Some("session_renamed")
        );
        assert_eq!(registry.len(), 1, "moved, not duplicated");
        assert!(registry.attach(&first).is_none());
        assert!(registry.attach("session_renamed").is_some());
        assert!(registry.unregister(&session));
        assert!(registry.is_empty());
    }

    /// The sink runs inside the session lock — in the same critical section
    /// that assigned the revision — so the message reaches the host's queue
    /// before any other emitter on this session can take the next revision.
    #[test]
    fn test_agent_dispatch_emits_while_session_lock_is_held() {
        let registry = SessionRegistry::new();
        let session = counting_session();
        let _ = session.handle_hello(None);
        let lock_was_held: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: OutboundSink = {
            let probe = Arc::clone(&session);
            let seen = Arc::clone(&lock_was_held);
            Arc::new(move |_msg| {
                let held = matches!(
                    probe.inner.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                );
                seen.lock().unwrap().push(held);
            })
        };
        let id = registry.register(&session, sink).unwrap().unwrap();
        let handle = registry.attach(&id).unwrap();
        // The sink holds an `Arc` for its probe; the handle itself does not.
        assert_eq!(Arc::strong_count(&session), 2);

        handle.dispatch("increment", None).unwrap();
        assert_eq!(*lock_was_held.lock().unwrap(), vec![true]);
    }

    /// Same guarantee for the socket task's own replies: `handle_message_with`
    /// hands each reply out before releasing the lock, and `handle_message`
    /// is exactly the collecting form of it.
    #[test]
    fn test_handle_message_with_emits_while_session_lock_is_held() {
        let session = counting_session();
        let mut hello_held = Vec::new();
        session.handle_message_with(r#"{"type":"hello"}"#, |_| {
            hello_held.push(matches!(
                session.inner.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
        });
        assert_eq!(hello_held, vec![true, true], "sessionAck, initialTree");

        let mut emitted = Vec::new();
        session.handle_message_with(
            r#"{"type":"dispatchAction","module":"App","action":"increment"}"#,
            |m| {
                assert!(matches!(
                    session.inner.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                emitted.push(m.to_string());
            },
        );
        assert_eq!(emitted.len(), 1);
        assert!(emitted[0].contains(r#""revision":1"#), "{}", emitted[0]);

        let collected = session
            .handle_message(r#"{"type":"dispatchAction","module":"App","action":"increment"}"#);
        assert_eq!(collected.len(), 1);
        assert!(collected[0].contains(r#""revision":2"#), "{}", collected[0]);
    }

    /// Agents and clicks racing on one session: because every emitter
    /// queues under the lock that assigns the revision, the single queue
    /// that feeds the socket always sees revisions strictly ascending. Before
    /// the fix, the sink ran after the lock was released and a click served
    /// in that window put N+1 on the wire before N.
    #[test]
    fn test_concurrent_agent_and_click_revisions_are_queued_in_order() {
        const AGENTS: usize = 4;
        const CLICKERS: usize = 4;
        const ROUNDS: usize = 25;

        let registry = Arc::new(SessionRegistry::new());
        let session = counting_session();
        let _ = session.handle_hello(None);
        // The one queue a socket writer would drain.
        let queue: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: OutboundSink = {
            let q = Arc::clone(&queue);
            Arc::new(move |m| q.lock().unwrap().push(m))
        };
        let id = registry.register(&session, sink).unwrap().unwrap();

        let mut workers = Vec::new();
        for _ in 0..AGENTS {
            let handle = registry.attach(&id).unwrap();
            workers.push(std::thread::spawn(move || {
                for _ in 0..ROUNDS {
                    handle.dispatch("increment", None).unwrap();
                }
            }));
        }
        for _ in 0..CLICKERS {
            let session = Arc::clone(&session);
            let q = Arc::clone(&queue);
            workers.push(std::thread::spawn(move || {
                for _ in 0..ROUNDS {
                    session.handle_message_with(
                        r#"{"type":"dispatchAction","module":"App","action":"increment"}"#,
                        |m| q.lock().unwrap().push(m.to_string()),
                    );
                }
            }));
        }
        for w in workers {
            w.join().unwrap();
        }

        let total = (AGENTS + CLICKERS) * ROUNDS;
        let revisions: Vec<u64> = queue
            .lock()
            .unwrap()
            .iter()
            .map(|m| {
                serde_json::from_str::<Value>(m).unwrap()["revision"]
                    .as_u64()
                    .unwrap()
            })
            .collect();
        assert_eq!(revisions.len(), total);
        assert_eq!(
            revisions,
            (1..=total as u64).collect::<Vec<_>>(),
            "queue order must equal revision order"
        );
        assert_eq!(session.revision(), total as u64);
        assert_eq!(session.get_state()["count"], total);
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
            ..SessionConfig::default()
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
