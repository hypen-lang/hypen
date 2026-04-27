use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::Value;

#[cfg(feature = "async")]
use std::future::Future;
#[cfg(feature = "async")]
use std::pin::Pin;

use crate::context::GlobalContext;
use crate::error::{Result, SdkError};
use crate::state::{State, StateContainer};

/// A boxed, pinned, Send future — the return type of async handlers.
#[cfg(feature = "async")]
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

// ---------------------------------------------------------------------------
// Callback signatures
// ---------------------------------------------------------------------------

/// Sync lifecycle callback: borrows state, may read global context.
type SyncLifecycleFn<S> = Box<dyn Fn(&S, Option<&GlobalContext>) + Send + Sync>;

/// Sync action handler: takes mutable state, optional raw JSON payload,
/// and optional global context.
type SyncActionFn<S> = Box<dyn Fn(&mut S, Option<&Value>, Option<&GlobalContext>) + Send + Sync>;

/// Async lifecycle callback: takes owned state, returns owned state after `.await`.
#[cfg(feature = "async")]
type AsyncLifecycleFn<S> =
    Box<dyn Fn(S, Option<Arc<GlobalContext>>) -> BoxFuture<S> + Send + Sync>;

/// Async action handler: takes owned state, optional raw JSON payload,
/// and optional global context. Returns owned state after `.await`.
#[cfg(feature = "async")]
type AsyncActionFn<S> =
    Box<dyn Fn(S, Option<Value>, Option<Arc<GlobalContext>>) -> BoxFuture<S> + Send + Sync>;

/// Error handler: receives the error context and returns whether the error was handled.
type ErrorHandler = Box<dyn Fn(&ErrorContext) -> ErrorResult + Send + Sync>;

/// Coerce a raw JSON action payload into the handler's declared type `A`.
///
/// Shared by `on_action` and `on_action_async`. The tricky case is
/// `on_action::<()>`: the DOM renderer always dispatches a payload (a
/// `MouseEvent` snapshot like `{type: "click", clientX, …}`) even when the
/// DSL author wrote `.onClick(@actions.X)` with no explicit args. A strict
/// `from_value::<()>(payload)` rejects anything that isn't `null`, so the
/// handler would silently never fire.
///
/// Strategy: try the typed payload first (happy path for `on_action::<MyT>`
/// when the payload matches), and if that fails, fall back to `Null` — which
/// succeeds for `A = ()` and any `A: Default` via `#[serde(default)]`. Only
/// warn when *both* paths fail, since that almost always means a typo in
/// either the handler's declared type or the DSL dispatch site.
fn deserialize_action_payload<A: DeserializeOwned>(
    action_name: &str,
    raw: Option<&Value>,
) -> Option<A> {
    match raw {
        Some(v) => match serde_json::from_value::<A>(v.clone()) {
            Ok(a) => Some(a),
            Err(primary_err) => match serde_json::from_value::<A>(Value::Null) {
                Ok(a) => Some(a),
                Err(_) => {
                    eprintln!(
                        "[hypen-server] action {:?} payload did not deserialize into declared type: {} (payload was {})",
                        action_name,
                        primary_err,
                        v,
                    );
                    None
                }
            },
        },
        None => serde_json::from_value::<A>(Value::Null).ok(),
    }
}

// One slot per concept (sync or async). The `Async` variant is cfg-gated so
// the enum has just one arm when the feature is off; sync dispatch paths
// only fire on `Sync`, async paths fire on either. This preserves the
// original behavior where an async-only handler is invisible to sync callers.

pub(crate) enum LifecycleHandler<S> {
    Sync(SyncLifecycleFn<S>),
    #[cfg(feature = "async")]
    Async(AsyncLifecycleFn<S>),
}

pub(crate) enum ActionHandler<S> {
    Sync(SyncActionFn<S>),
    #[cfg(feature = "async")]
    Async(AsyncActionFn<S>),
}

/// Context provided to error handlers.
pub struct ErrorContext {
    pub error: SdkError,
    pub action_name: Option<String>,
    pub lifecycle: Option<String>,
}

/// Result from an error handler.
pub struct ErrorResult {
    /// If true, the error is considered handled and won't propagate.
    pub handled: bool,
}

/// Session information passed to disconnect/reconnect/expire handlers.
pub use crate::remote::SessionInfo;

/// Disconnect handler: fires when the last connection for a session drops.
type DisconnectFn<S> = Box<dyn Fn(&S, &SessionInfo) + Send + Sync>;
/// Reconnect handler: fires when a client resumes a suspended session.
/// Receives the current state, session info, and the saved state snapshot.
/// The handler should mutate `state` via the mutable ref if it wants to
/// restore — by default the caller applies `saved_state` when the handler
/// does not set `restored` to true.
type ReconnectFn<S> = Box<dyn Fn(&mut S, &SessionInfo, &serde_json::Value) + Send + Sync>;
/// Expire handler: fires when a suspended session's TTL elapses.
type ExpireFn = Box<dyn Fn(&SessionInfo) + Send + Sync>;

// ---------------------------------------------------------------------------
// ModuleDefinition
// ---------------------------------------------------------------------------

/// An immutable, built module definition.
///
/// Created via `ModuleBuilder::build()`. Contains all state, handlers, and
/// UI configuration needed to instantiate a running module.
pub struct ModuleDefinition<S: State> {
    pub(crate) name: String,
    pub(crate) initial_state: S,
    pub(crate) ui_source: Option<String>,
    pub(crate) ui_file: Option<String>,
    pub(crate) action_handlers: HashMap<String, ActionHandler<S>>,
    pub(crate) on_created: Option<LifecycleHandler<S>>,
    pub(crate) on_activated: Option<LifecycleHandler<S>>,
    pub(crate) on_deactivated: Option<LifecycleHandler<S>>,
    pub(crate) on_destroyed: Option<LifecycleHandler<S>>,
    #[allow(dead_code)]
    pub(crate) on_error: Option<ErrorHandler>,
    pub(crate) on_disconnect: Option<DisconnectFn<S>>,
    pub(crate) on_reconnect: Option<ReconnectFn<S>>,
    pub(crate) on_expire: Option<ExpireFn>,
    pub(crate) persist: bool,
    pub(crate) resource_map: indexmap::IndexMap<String, String>,
}

impl<S: State> ModuleDefinition<S> {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn action_names(&self) -> Vec<String> {
        self.action_handlers.keys().cloned().collect()
    }

    pub fn ui_source(&self) -> Option<&str> {
        self.ui_source.as_deref()
    }

    pub fn is_persistent(&self) -> bool {
        self.persist
    }
}

// ---------------------------------------------------------------------------
// ModuleBuilder (fluent API)
// ---------------------------------------------------------------------------

/// Fluent builder for constructing a `ModuleDefinition`.
///
/// # Example
///
/// ```rust,ignore
/// use hypen_server::prelude::*;
/// use serde::{Deserialize, Serialize};
///
/// #[derive(Clone, Default, Serialize, Deserialize)]
/// struct Counter { count: i32 }
///
/// #[derive(Deserialize)]
/// struct AddPayload { amount: i32 }
///
/// let module = ModuleBuilder::new("Counter")
///     .state(Counter { count: 0 })
///     .ui(r#"Column { Text("Count: @{state.count}") }"#)
///     .on_action::<()>("increment", |state, _, _ctx| {
///         state.count += 1;
///     })
///     .on_action::<AddPayload>("add", |state, payload, _ctx| {
///         state.count += payload.amount;
///     })
///     .build();
/// ```
pub struct ModuleBuilder<S: State> {
    name: String,
    initial_state: Option<S>,
    ui_source: Option<String>,
    ui_file: Option<String>,
    action_handlers: HashMap<String, ActionHandler<S>>,
    on_created: Option<LifecycleHandler<S>>,
    on_activated: Option<LifecycleHandler<S>>,
    on_deactivated: Option<LifecycleHandler<S>>,
    on_destroyed: Option<LifecycleHandler<S>>,
    on_error: Option<ErrorHandler>,
    on_disconnect: Option<DisconnectFn<S>>,
    on_reconnect: Option<ReconnectFn<S>>,
    on_expire: Option<ExpireFn>,
    persist: bool,
    resource_map: indexmap::IndexMap<String, String>,
}

impl<S: State> ModuleBuilder<S> {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            initial_state: None,
            ui_source: None,
            ui_file: None,
            action_handlers: HashMap::new(),
            on_created: None,
            on_activated: None,
            on_deactivated: None,
            on_destroyed: None,
            on_error: None,
            on_disconnect: None,
            on_reconnect: None,
            on_expire: None,
            persist: false,
            resource_map: indexmap::IndexMap::new(),
        }
    }

    /// Set the initial state for this module.
    pub fn state(mut self, initial: S) -> Self {
        self.initial_state = Some(initial);
        self
    }

    /// Set the Hypen DSL template as an inline string.
    ///
    /// ```rust,ignore
    /// .ui(r#"
    ///     Column {
    ///         Text("Count: @{state.count}")
    ///         Button("@actions.increment") { Text("+") }
    ///     }
    /// "#)
    /// ```
    pub fn ui(mut self, source: impl Into<String>) -> Self {
        self.ui_source = Some(source.into());
        self
    }

    /// Load the Hypen DSL template from a file path.
    ///
    /// The file will be read when the module is instantiated.
    pub fn ui_file(mut self, path: impl Into<String>) -> Self {
        self.ui_file = Some(path.into());
        self
    }

    /// Register an action handler with a typed payload.
    ///
    /// The type parameter `A` determines how the action payload is
    /// deserialized. Use `()` for actions that don't carry a payload.
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// // No payload — use ()
    /// .on_action::<()>("increment", |state, _, _ctx| {
    ///     state.count += 1;
    /// })
    ///
    /// // Typed payload — any Deserialize type
    /// #[derive(Deserialize)]
    /// struct SetValue { value: i32 }
    ///
    /// .on_action::<SetValue>("set_value", |state, payload, _ctx| {
    ///     state.count = payload.value;
    /// })
    ///
    /// // Raw JSON access
    /// .on_action::<serde_json::Value>("raw", |state, raw, _ctx| {
    ///     if let Some(n) = raw.as_i64() { state.count = n as i32; }
    /// })
    /// ```
    pub fn on_action<A>(
        mut self,
        name: impl Into<String>,
        handler: impl Fn(&mut S, A, Option<&GlobalContext>) + Send + Sync + 'static,
    ) -> Self
    where
        A: DeserializeOwned + 'static,
    {
        let name = name.into();
        let action_name = name.clone();
        let wrapped: SyncActionFn<S> = Box::new(move |state, raw, ctx| {
            let action = deserialize_action_payload::<A>(&action_name, raw);
            if let Some(action) = action {
                handler(state, action, ctx);
            }
        });
        self.action_handlers
            .insert(name, ActionHandler::Sync(wrapped));
        self
    }

    /// Called when the module is first mounted.
    pub fn on_created<F>(mut self, handler: F) -> Self
    where
        F: Fn(&S, Option<&GlobalContext>) + Send + Sync + 'static,
    {
        self.on_created = Some(LifecycleHandler::Sync(Box::new(handler)));
        self
    }

    /// Called when the module is destroyed/unmounted.
    pub fn on_destroyed<F>(mut self, handler: F) -> Self
    where
        F: Fn(&S, Option<&GlobalContext>) + Send + Sync + 'static,
    {
        self.on_destroyed = Some(LifecycleHandler::Sync(Box::new(handler)));
        self
    }

    /// Called every time the module becomes the active route.
    ///
    /// Unlike [`on_created`](Self::on_created) (which fires once per
    /// instance), `on_activated` fires on every mount — including when
    /// a persisted instance is restored from the [`ManagedRouter`]
    /// cache. Use this for "refresh on entry" work like reading the
    /// current path params.
    pub fn on_activated<F>(mut self, handler: F) -> Self
    where
        F: Fn(&S, Option<&GlobalContext>) + Send + Sync + 'static,
    {
        self.on_activated = Some(LifecycleHandler::Sync(Box::new(handler)));
        self
    }

    /// Called every time the module loses the active route — paired
    /// with [`on_activated`](Self::on_activated). Fires before either
    /// `on_destroyed` (when not persisting) or the persist cache write.
    pub fn on_deactivated<F>(mut self, handler: F) -> Self
    where
        F: Fn(&S, Option<&GlobalContext>) + Send + Sync + 'static,
    {
        self.on_deactivated = Some(LifecycleHandler::Sync(Box::new(handler)));
        self
    }

    /// Register an error handler for this module.
    pub fn on_error<F>(mut self, handler: F) -> Self
    where
        F: Fn(&ErrorContext) -> ErrorResult + Send + Sync + 'static,
    {
        self.on_error = Some(Box::new(handler));
        self
    }

    /// Called when the last WebSocket connection for a session drops
    /// and the session is about to be suspended. The handler receives
    /// the current state (read-only) and session information.
    pub fn on_disconnect<F>(mut self, handler: F) -> Self
    where
        F: Fn(&S, &SessionInfo) + Send + Sync + 'static,
    {
        self.on_disconnect = Some(Box::new(handler));
        self
    }

    /// Called when a client reconnects to a suspended session within the
    /// TTL window. The handler receives a mutable reference to the
    /// current (fresh) state, the session info, and the saved-state JSON.
    /// If the handler wants to restore the saved state, it should
    /// deserialize and write it into `state`; otherwise the caller will
    /// apply the saved state automatically.
    pub fn on_reconnect<F>(mut self, handler: F) -> Self
    where
        F: Fn(&mut S, &SessionInfo, &serde_json::Value) + Send + Sync + 'static,
    {
        self.on_reconnect = Some(Box::new(handler));
        self
    }

    /// Called when a suspended session's TTL elapses without a reconnect.
    /// The module is destroyed immediately after this handler returns.
    pub fn on_expire<F>(mut self, handler: F) -> Self
    where
        F: Fn(&SessionInfo) + Send + Sync + 'static,
    {
        self.on_expire = Some(Box::new(handler));
        self
    }

    /// Register a single SVG resource by name.
    ///
    /// ```rust,ignore
    /// .resource("heart", r#"<svg viewBox="0 0 24 24"><path d="M20.84..."/></svg>"#)
    /// ```
    pub fn resource(mut self, name: impl Into<String>, svg: impl Into<String>) -> Self {
        self.resource_map.insert(name.into(), svg.into());
        self
    }

    /// Register multiple SVG resources from a map.
    pub fn resources(mut self, map: indexmap::IndexMap<String, String>) -> Self {
        self.resource_map.extend(map);
        self
    }

    /// Load SVG resources from all `.svg` files in a directory.
    ///
    /// Each file becomes a resource named after its filename (without extension).
    /// For example, `heart.svg` → `@resources.heart`.
    pub fn resources_dir(mut self, path: impl AsRef<std::path::Path>) -> Self {
        if let Ok(entries) = std::fs::read_dir(path.as_ref()) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("svg") {
                    let name = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if let Ok(svg) = std::fs::read_to_string(&p) {
                        self.resource_map.insert(name, svg);
                    }
                }
            }
        } else {
            eprintln!(
                "Warning: could not read resources dir: {}",
                path.as_ref().display()
            );
        }
        self
    }


    /// Load SVG resources from a JSON file (name → SVG string map).
    ///
    /// ```json
    /// { "heart": "<svg>...</svg>", "search": "<svg>...</svg>" }
    /// ```
    pub fn resources_file(mut self, path: impl AsRef<std::path::Path>) -> Self {
        match std::fs::read_to_string(path.as_ref()) {
            Ok(json) => {
                if let Ok(map) = serde_json::from_str::<indexmap::IndexMap<String, String>>(&json) {
                    self.resource_map.extend(map);
                } else {
                    eprintln!(
                        "Warning: could not parse resources file {}: expected {{name: svg}} map",
                        path.as_ref().display()
                    );
                }
            }
            Err(e) => eprintln!(
                "Warning: could not read resources file {}: {}",
                path.as_ref().display(),
                e
            ),
        }
        self
    }

    pub fn persist(mut self) -> Self {
        self.persist = true;
        self
    }

    /// Register an async action handler with a typed payload.
    ///
    /// The handler takes **owned** state, performs async work, and returns
    /// the (possibly mutated) state. This avoids holding `&mut` across
    /// `.await` points.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// .on_action_async::<AddPayload>("add", |mut state, payload, _ctx| {
    ///     Box::pin(async move {
    ///         state.count += payload.amount;
    ///         state
    ///     })
    /// })
    /// ```
    #[cfg(feature = "async")]
    pub fn on_action_async<A>(
        mut self,
        name: impl Into<String>,
        handler: impl Fn(S, A, Option<Arc<GlobalContext>>) -> BoxFuture<S> + Send + Sync + 'static,
    ) -> Self
    where
        A: DeserializeOwned + Send + 'static,
    {
        let name = name.into();
        let action_name = name.clone();
        let wrapped: AsyncActionFn<S> = Box::new(move |state, raw, ctx| {
            let action = deserialize_action_payload::<A>(&action_name, raw.as_ref());
            if let Some(action) = action {
                handler(state, action, ctx)
            } else {
                Box::pin(async move { state })
            }
        });
        self.action_handlers
            .insert(name, ActionHandler::Async(wrapped));
        self
    }

    /// Register an async `on_created` lifecycle handler.
    ///
    /// Takes owned state and returns it after async work.
    ///
    /// ```rust,ignore
    /// .on_created_async(|mut state, _ctx| {
    ///     Box::pin(async move {
    ///         // fetch data, initialize, etc.
    ///         state
    ///     })
    /// })
    /// ```
    #[cfg(feature = "async")]
    pub fn on_created_async(
        mut self,
        handler: impl Fn(S, Option<Arc<GlobalContext>>) -> BoxFuture<S> + Send + Sync + 'static,
    ) -> Self {
        self.on_created = Some(LifecycleHandler::Async(Box::new(handler)));
        self
    }

    /// Register an async `on_destroyed` lifecycle handler.
    ///
    /// Takes owned state and returns it after async cleanup.
    ///
    /// ```rust,ignore
    /// .on_destroyed_async(|state, _ctx| {
    ///     Box::pin(async move {
    ///         // cleanup, flush logs, etc.
    ///         state
    ///     })
    /// })
    /// ```
    #[cfg(feature = "async")]
    pub fn on_destroyed_async(
        mut self,
        handler: impl Fn(S, Option<Arc<GlobalContext>>) -> BoxFuture<S> + Send + Sync + 'static,
    ) -> Self {
        self.on_destroyed = Some(LifecycleHandler::Async(Box::new(handler)));
        self
    }

    /// Consume the builder and produce an immutable `ModuleDefinition`.
    pub fn build(self) -> ModuleDefinition<S> {
        let initial_state = self
            .initial_state
            .expect("ModuleBuilder::state() must be called before build()");

        ModuleDefinition {
            name: self.name,
            initial_state,
            ui_source: self.ui_source,
            ui_file: self.ui_file,
            action_handlers: self.action_handlers,
            on_created: self.on_created,
            on_activated: self.on_activated,
            on_deactivated: self.on_deactivated,
            on_destroyed: self.on_destroyed,
            on_error: self.on_error,
            on_disconnect: self.on_disconnect,
            on_reconnect: self.on_reconnect,
            on_expire: self.on_expire,
            persist: self.persist,
            resource_map: self.resource_map,
        }
    }
}

// ---------------------------------------------------------------------------
// ModuleInstance (running module)
// ---------------------------------------------------------------------------

/// A running module instance with live state.
///
/// Created from a `ModuleDefinition` when the module is mounted.
/// Wraps a `hypen_engine::Engine` and manages state synchronization.
pub struct ModuleInstance<S: State> {
    definition: Arc<ModuleDefinition<S>>,
    /// Arc-wrapped so engine-side action handlers (registered via
    /// `engine.on_action(...)` in `new` / `new_with_components`) can
    /// capture and mutate the state without holding the engine mutex.
    state: Arc<Mutex<StateContainer<S>>>,
    engine: Mutex<hypen_engine::Engine>,
    mounted: Mutex<bool>,
    global_context: Option<Arc<GlobalContext>>,
}

impl<S: State> ModuleInstance<S> {
    /// Create a new module instance from a definition.
    pub fn new(
        definition: Arc<ModuleDefinition<S>>,
        global_context: Option<Arc<GlobalContext>>,
    ) -> Result<Self> {
        let state_container = StateContainer::new(definition.initial_state.clone())?;
        let mut engine = hypen_engine::Engine::new();

        // Set up the engine module metadata
        let module_meta = hypen_engine::lifecycle::Module::new(&definition.name)
            .with_actions(definition.action_names())
            .with_persist(definition.persist);

        let initial_json = state_container.to_json()?;
        let engine_module = hypen_engine::ModuleInstance::new(module_meta, initial_json);
        engine.set_module(engine_module);

        // Register resources (name → raw SVG)
        for (name, svg) in &definition.resource_map {
            engine.register_resource(name, svg);
        }

        // Parse and load UI if provided
        if let Some(ref source) = definition.ui_source {
            Self::load_ui_source(&mut engine, source)?;
        } else if let Some(ref path) = definition.ui_file {
            let source = std::fs::read_to_string(path).map_err(|e| {
                SdkError::Component(format!("Failed to read UI file '{path}': {e}"))
            })?;
            Self::load_ui_source(&mut engine, &source)?;
        }

        let state = Arc::new(Mutex::new(state_container));
        Self::register_action_handlers_with_engine(
            &mut engine,
            Arc::clone(&definition),
            Arc::clone(&state),
            global_context.clone(),
        );

        Ok(Self {
            definition,
            state,
            engine: Mutex::new(engine),
            mounted: Mutex::new(false),
            global_context,
        })
    }

    /// Create a new module instance with a component registry for resolving
    /// child components in the UI template.
    ///
    /// This enables DSL like `Column { Feed {} }` where `Feed` is registered
    /// in the `ComponentRegistry`. Without a registry, the engine cannot resolve
    /// custom component references in the template.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let mut registry = ComponentRegistry::new();
    /// registry.register("Card", r#"Column { Text("Card") }"#, None);
    ///
    /// let instance = ModuleInstance::new_with_components(
    ///     Arc::new(def),
    ///     Some(ctx),
    ///     &registry,
    /// ).unwrap();
    /// ```
    pub fn new_with_components(
        definition: Arc<ModuleDefinition<S>>,
        global_context: Option<Arc<GlobalContext>>,
        components: &crate::discovery::ComponentRegistry,
    ) -> Result<Self> {
        let state_container = StateContainer::new(definition.initial_state.clone())?;
        let mut engine = hypen_engine::Engine::new();

        // Set up the engine module metadata
        let module_meta = hypen_engine::lifecycle::Module::new(&definition.name)
            .with_actions(definition.action_names())
            .with_persist(definition.persist);

        let initial_json = state_container.to_json()?;
        let engine_module = hypen_engine::ModuleInstance::new(module_meta, initial_json);
        engine.set_module(engine_module);

        // Register resources (name → raw SVG) so the engine can resolve
        // `@resources.xxx` references into concrete icon path data. Without
        // this, Icon create patches carry a literal "@resources.xxx" string
        // in props and renderers show nothing / a fallback glyph.
        for (name, svg) in &definition.resource_map {
            engine.register_resource(name, svg);
        }

        // Register component resolver so the engine can resolve child components
        let entries: Vec<(String, String, String)> = components
            .all()
            .iter()
            .map(|e| {
                (
                    e.name.clone(),
                    e.source.clone(),
                    e.path
                        .as_ref()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                )
            })
            .collect();

        engine.set_component_resolver(move |name, _ctx_path| {
            entries.iter().find(|(n, _, _)| n == name).map(
                |(_, source, path)| hypen_engine::ir::ResolvedComponent {
                    source: source.clone(),
                    path: path.clone(),
                    passthrough: false,
                    lazy: false,
                },
            )
        });

        // Parse and load UI if provided
        if let Some(ref source) = definition.ui_source {
            Self::load_ui_source(&mut engine, source)?;
        } else if let Some(ref path) = definition.ui_file {
            let source = std::fs::read_to_string(path).map_err(|e| {
                SdkError::Component(format!("Failed to read UI file '{path}': {e}"))
            })?;
            Self::load_ui_source(&mut engine, &source)?;
        }

        let state = Arc::new(Mutex::new(state_container));
        Self::register_action_handlers_with_engine(
            &mut engine,
            Arc::clone(&definition),
            Arc::clone(&state),
            global_context.clone(),
        );

        Ok(Self {
            definition,
            state,
            engine: Mutex::new(engine),
            mounted: Mutex::new(false),
            global_context,
        })
    }

    /// Register all sync action handlers from the definition with the engine
    /// via [`Engine::on_action`]. Each registration captures the per-instance
    /// state and global context Arcs and runs the typed handler when fired.
    /// Async handlers are not registered here — they're invoked directly from
    /// [`dispatch_action_async`].
    fn register_action_handlers_with_engine(
        engine: &mut hypen_engine::Engine,
        definition: Arc<ModuleDefinition<S>>,
        state: Arc<Mutex<StateContainer<S>>>,
        global_context: Option<Arc<GlobalContext>>,
    ) {
        for (action_name, handler) in definition.action_handlers.iter() {
            // Skip async-only handlers — the engine's action dispatcher is
            // sync, so async handlers are still invoked directly from
            // `dispatch_action_async`.
            #[cfg(feature = "async")]
            if matches!(handler, ActionHandler::Async(_)) {
                continue;
            }
            // Sync handlers route through the engine. The closure captures
            // Arcs of the definition (to look up the typed handler), the
            // state (to mutate), and the global context. The user-visible
            // `dispatch_action` calls `engine.dispatch_action(...)`, which
            // fires this closure inside the engine's action-scope latch.
            let definition = Arc::clone(&definition);
            let state = Arc::clone(&state);
            let global_context = global_context.clone();
            let action_name_owned = action_name.clone();
            engine.on_action(action_name.clone(), move |action| {
                if let Some(ActionHandler::Sync(handler)) =
                    definition.action_handlers.get(&action_name_owned)
                {
                    let ctx = global_context.as_deref();
                    let mut state_guard = state.lock().unwrap();
                    handler(state_guard.get_mut(), action.payload.as_ref(), ctx);
                }
            });
            // Suppress unused-variable warning when the `async` cfg branch
            // above is the only consumer.
            let _ = handler;
        }
    }

    fn load_ui_source(engine: &mut hypen_engine::Engine, source: &str) -> Result<()> {
        let doc = hypen_parser::parse_document(source).map_err(|e| {
            SdkError::Engine(hypen_engine::EngineError::ParseError {
                source: source.chars().take(80).collect(),
                message: format!("{e:?}"),
            })
        })?;
        let component = doc
            .components
            .first()
            .ok_or_else(|| SdkError::Component("No component found in UI source".to_string()))?;
        let ir_node = hypen_engine::ast_to_ir_node(component);
        engine.render_ir_node(&ir_node);
        Ok(())
    }

    /// Mount the module (triggers `on_created` if it was registered as sync).
    ///
    /// Async-only lifecycle handlers are silently skipped here — call
    /// [`mount_async`](Self::mount_async) to invoke them.
    pub fn mount(&self) {
        let mut mounted = self.mounted.lock().unwrap();
        if !*mounted {
            *mounted = true;
            if let Some(LifecycleHandler::Sync(ref handler)) = self.definition.on_created {
                let state = self.state.lock().unwrap();
                let ctx = self.global_context.as_deref();
                handler(state.get(), ctx);
            }
        }
    }

    /// Fire `on_activated` (sync only). Called by [`ManagedRouter`] every
    /// time the module gains the active route slot — including persist
    /// cache restores. Independent of [`mount`](Self::mount); does not
    /// flip `mounted`.
    pub fn activate(&self) {
        if let Some(LifecycleHandler::Sync(ref handler)) = self.definition.on_activated {
            let state = self.state.lock().unwrap();
            let ctx = self.global_context.as_deref();
            handler(state.get(), ctx);
        }
    }

    /// Fire `on_deactivated` (sync only). Paired with
    /// [`activate`](Self::activate); fires before `on_destroyed` or
    /// before the persist-cache write.
    pub fn deactivate(&self) {
        if let Some(LifecycleHandler::Sync(ref handler)) = self.definition.on_deactivated {
            let state = self.state.lock().unwrap();
            let ctx = self.global_context.as_deref();
            handler(state.get(), ctx);
        }
    }

    /// Unmount the module (triggers `on_destroyed` if it was registered as sync).
    ///
    /// Async-only lifecycle handlers are silently skipped here — call
    /// [`unmount_async`](Self::unmount_async) to invoke them.
    pub fn unmount(&self) {
        let mut mounted = self.mounted.lock().unwrap();
        if *mounted {
            if let Some(LifecycleHandler::Sync(ref handler)) = self.definition.on_destroyed {
                let state = self.state.lock().unwrap();
                let ctx = self.global_context.as_deref();
                handler(state.get(), ctx);
            }
            *mounted = false;
        }
    }

    /// Dispatch an action by name with an optional payload.
    ///
    /// Only sync handlers run here. Actions registered as async-only return
    /// `ActionNotFound` — call [`dispatch_action_async`](Self::dispatch_action_async)
    /// for async handlers.
    ///
    /// The dispatch routes through `engine.dispatch_action(...)`, which fires
    /// the per-action closure registered in `register_action_handlers_with_engine`
    /// during construction. That closure runs the typed handler against the
    /// per-instance state. After dispatch returns, this method diffs the
    /// state against its pre-handler snapshot and pushes any changed paths
    /// to the engine via `engine.update_state(None, patch)`.
    pub fn dispatch_action(&self, name: impl Into<String>, payload: Option<Value>) -> Result<()> {
        let name = name.into();

        // `__hypen_bind` is the engine-level reserved action used by renderers
        // for two-way binding. It carries `{path, value}` and writes the value
        // back into module state at the dotted path. No user handler is
        // involved — see ENGINE_CONTRACT.md §13.
        if name == "__hypen_bind" {
            return self.handle_bind_action(payload);
        }

        // Reject async-only handlers up front (they can't be invoked from
        // a sync engine.on_action callback). Sync handlers are registered
        // on the engine in `register_action_handlers_with_engine`, so an
        // unknown action that has no engine handler also surfaces here as
        // `ActionNotFound` — but we let `engine.dispatch_action` produce
        // that error itself for consistency.
        #[cfg(feature = "async")]
        if matches!(
            self.definition.action_handlers.get(&name),
            Some(ActionHandler::Async(_))
        ) {
            return Err(SdkError::Engine(hypen_engine::EngineError::ActionNotFound(
                name,
            )));
        }

        // Snapshot state before handler runs (the engine fires the registered
        // closure synchronously inside dispatch_action; the closure mutates
        // our state in place via the captured Arc).
        {
            let mut state = self.state.lock().unwrap();
            state.take_snapshot()?;
        }

        // Build the action and dispatch through the engine. The engine's
        // action-scope latch is set during the call, and the registered
        // closure runs the typed handler against `self.state` (via the
        // captured Arc).
        let mut action = hypen_engine::dispatch::Action::new(name.clone());
        if let Some(p) = payload {
            action = action.with_payload(p);
        }
        {
            let mut engine = self.engine.lock().unwrap();
            engine
                .dispatch_action(action)
                .map_err(SdkError::Engine)?;
        }

        // Diff state and notify engine of changes
        self.sync_state_to_engine()?;

        Ok(())
    }

    /// Get a clone of the current state.
    pub fn get_state(&self) -> S {
        self.state.lock().unwrap().get().clone()
    }

    /// Get the current state as JSON.
    pub fn get_state_json(&self) -> Result<Value> {
        self.state.lock().unwrap().to_json()
    }

    /// Set the render callback for receiving patches.
    pub fn on_patches<F>(&self, callback: F)
    where
        F: Fn(&[hypen_engine::Patch]) + Send + Sync + 'static,
    {
        let mut engine = self.engine.lock().unwrap();
        engine.set_render_callback(callback);
    }

    /// Check if the module is currently mounted.
    pub fn is_mounted(&self) -> bool {
        *self.mounted.lock().unwrap()
    }

    /// Name of this module.
    pub fn name(&self) -> &str {
        &self.definition.name
    }

    /// Mount the module asynchronously. Runs whichever variant of
    /// `on_created` was registered (sync or async).
    #[cfg(feature = "async")]
    pub async fn mount_async(&self) {
        {
            let mut mounted = self.mounted.lock().unwrap();
            if *mounted {
                return;
            }
            *mounted = true;
        }

        match &self.definition.on_created {
            Some(LifecycleHandler::Async(handler)) => {
                let current_state = self.state.lock().unwrap().get().clone();
                let ctx = self.global_context.clone();
                let new_state = handler(current_state, ctx).await;
                *self.state.lock().unwrap().get_mut() = new_state;
            }
            Some(LifecycleHandler::Sync(handler)) => {
                let state = self.state.lock().unwrap();
                let ctx = self.global_context.as_deref();
                handler(state.get(), ctx);
            }
            None => {}
        }
    }

    /// Unmount the module asynchronously. Runs whichever variant of
    /// `on_destroyed` was registered (sync or async).
    #[cfg(feature = "async")]
    pub async fn unmount_async(&self) {
        {
            let mounted = self.mounted.lock().unwrap();
            if !*mounted {
                return;
            }
        }

        match &self.definition.on_destroyed {
            Some(LifecycleHandler::Async(handler)) => {
                let current_state = self.state.lock().unwrap().get().clone();
                let ctx = self.global_context.clone();
                let new_state = handler(current_state, ctx).await;
                *self.state.lock().unwrap().get_mut() = new_state;
            }
            Some(LifecycleHandler::Sync(handler)) => {
                let state = self.state.lock().unwrap();
                let ctx = self.global_context.as_deref();
                handler(state.get(), ctx);
            }
            None => {}
        }

        *self.mounted.lock().unwrap() = false;
    }

    /// Dispatch an action asynchronously. Runs whichever variant of the
    /// handler was registered (sync or async).
    #[cfg(feature = "async")]
    pub async fn dispatch_action_async(
        &self,
        name: impl Into<String>,
        payload: Option<Value>,
    ) -> Result<()> {
        let name = name.into();

        // `__hypen_bind` is synchronous regardless of async dispatch — see
        // the comment in `dispatch_action`.
        if name == "__hypen_bind" {
            return self.handle_bind_action(payload);
        }

        // Snapshot state before handler runs
        {
            let mut state = self.state.lock().unwrap();
            state.take_snapshot()?;
        }

        match self.definition.action_handlers.get(&name) {
            Some(ActionHandler::Async(handler)) => {
                let current_state = self.state.lock().unwrap().get().clone();
                let ctx = self.global_context.clone();
                let new_state = handler(current_state, payload, ctx).await;
                *self.state.lock().unwrap().get_mut() = new_state;
            }
            Some(ActionHandler::Sync(handler)) => {
                let ctx = self.global_context.as_deref();
                let mut state = self.state.lock().unwrap();
                handler(state.get_mut(), payload.as_ref(), ctx);
            }
            None => {
                return Err(SdkError::Engine(hypen_engine::EngineError::ActionNotFound(
                    name,
                )));
            }
        }

        self.sync_state_to_engine()?;
        Ok(())
    }

    /// Internal: handle a `__hypen_bind` action from a renderer.
    ///
    /// Parses `{path, value}` from the payload, snapshots the current state,
    /// applies the bind via JSON round-trip through `S` (so a path that
    /// references a field not present on `S` is rejected with
    /// [`SdkError::StateSerde`]), and syncs the resulting state back to the
    /// engine. See ENGINE_CONTRACT.md §13 for the cross-SDK contract.
    fn handle_bind_action(&self, payload: Option<Value>) -> Result<()> {
        let payload = payload.ok_or_else(|| SdkError::ActionPayload {
            action: "__hypen_bind".into(),
            message: "missing payload".into(),
        })?;
        let obj = payload.as_object().ok_or_else(|| SdkError::ActionPayload {
            action: "__hypen_bind".into(),
            message: "payload must be an object".into(),
        })?;
        let path = obj
            .get("path")
            .and_then(|p| p.as_str())
            .ok_or_else(|| SdkError::ActionPayload {
                action: "__hypen_bind".into(),
                message: "missing 'path' string field".into(),
            })?
            .to_string();
        let value = obj.get("value").cloned().unwrap_or(Value::Null);

        {
            let mut state = self.state.lock().unwrap();
            state.take_snapshot()?;
            let new_typed: S = crate::state::apply_bind(state.get(), &path, value)?;
            *state.get_mut() = new_typed;
        }

        self.sync_state_to_engine()
    }

    /// Internal: compare state against pre-handler snapshot and push changes
    /// to the engine.
    ///
    /// `ModuleInstance` installs its module via `engine.set_module(...)`, which
    /// puts it in the engine's primary slot. The corresponding write path
    /// uses `None` as the scope, not `Some(self.definition.name)` — passing a
    /// non-empty scope routes through `EngineCore::update_state`'s named-module
    /// lookup, finds nothing, and silently no-ops the entire update (no dirty
    /// marking, no patches emitted). The previous comment here incorrectly
    /// claimed `effective_scope` rescued this; `effective_scope` is a read-side
    /// filter applied during reconciliation, not a write-side router on
    /// `update_state`.
    fn sync_state_to_engine(&self) -> Result<()> {
        let state = self.state.lock().unwrap();
        let paths = state.changed_paths()?;

        if !paths.is_empty() {
            let patch = state.diff_patch()?;
            drop(state); // release lock before engine lock

            let mut engine = self.engine.lock().unwrap();
            engine.update_state(None, patch);
        }

        Ok(())
    }
}

/// Create a nested module instance and register its state in the GlobalContext.
///
/// This creates a `ModuleInstance` from the given definition, registers its
/// initial state in the `GlobalContext` under the module's lowercase name,
/// and mounts the instance.
///
/// This is the Rust equivalent of the TypeScript SDK's `createNestedModuleInstances()`.
///
/// # Example
///
/// ```rust,ignore
/// use hypen_server::prelude::*;
///
/// let ctx = Arc::new(GlobalContext::new());
/// let def = Arc::new(ModuleBuilder::<MyState>::new("Feed")
///     .state(MyState::default())
///     .build());
///
/// let instance = create_nested_instance(def, ctx.clone()).unwrap();
/// assert!(ctx.has_module("feed"));
/// ```
pub fn create_nested_instance<S: State>(
    definition: Arc<ModuleDefinition<S>>,
    context: Arc<GlobalContext>,
) -> Result<ModuleInstance<S>> {
    let instance = ModuleInstance::new(definition, Some(context.clone()))?;
    let name = instance.name().to_lowercase();
    let state_json = instance.get_state_json()?;
    context.register_module_state(&name, state_json);
    instance.mount();
    Ok(instance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::sync::atomic::{AtomicI32, Ordering};

    #[derive(Clone, Default, Serialize, Deserialize, Debug)]
    struct TestState {
        count: i32,
        name: String,
    }

    #[test]
    fn test_module_builder_action() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState {
                count: 0,
                name: "Alice".into(),
            })
            .on_action::<()>("increment", |state, _, _ctx| {
                state.count += 1;
            })
            .build();

        assert_eq!(def.name(), "Test");
        assert!(def.action_names().contains(&"increment".to_string()));
    }

    #[test]
    fn test_module_builder_with_ui() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .ui(r#"Column { Text("Hello") }"#)
            .build();

        assert_eq!(def.ui_source(), Some(r#"Column { Text("Hello") }"#));
    }

    #[test]
    fn test_module_instance_dispatch() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState {
                count: 0,
                name: "Alice".into(),
            })
            .on_action::<()>("increment", |state, _, _ctx| {
                state.count += 1;
            })
            .on_action::<String>("set_name", |state, name, _ctx| {
                state.name = name;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.mount();

        instance.dispatch_action("increment", None).unwrap();
        assert_eq!(instance.get_state().count, 1);

        instance.dispatch_action("increment", None).unwrap();
        assert_eq!(instance.get_state().count, 2);

        instance
            .dispatch_action("set_name", Some(serde_json::json!("Bob")))
            .unwrap();
        assert_eq!(instance.get_state().name, "Bob");
    }

    #[test]
    fn test_module_lifecycle() {
        let created = Arc::new(AtomicI32::new(0));
        let destroyed = Arc::new(AtomicI32::new(0));

        let created_clone = created.clone();
        let destroyed_clone = destroyed.clone();

        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .on_created(move |_state, _ctx| {
                created_clone.fetch_add(1, Ordering::SeqCst);
            })
            .on_destroyed(move |_state, _ctx| {
                destroyed_clone.fetch_add(1, Ordering::SeqCst);
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        assert_eq!(created.load(Ordering::SeqCst), 0);
        instance.mount();
        assert_eq!(created.load(Ordering::SeqCst), 1);

        // Mounting again should be idempotent
        instance.mount();
        assert_eq!(created.load(Ordering::SeqCst), 1);

        instance.unmount();
        assert_eq!(destroyed.load(Ordering::SeqCst), 1);

        // Unmounting again should be idempotent
        instance.unmount();
        assert_eq!(destroyed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_module_unknown_action() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        let result = instance.dispatch_action("nonexistent", None);
        assert!(result.is_err());
    }

    #[test]
    fn test_module_persist_flag() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .persist()
            .build();

        assert!(def.is_persistent());
    }

    #[test]
    fn test_module_typed_payload() {
        #[derive(Deserialize)]
        struct AddPayload {
            amount: i32,
        }

        let def = ModuleBuilder::<TestState>::new("TypedTest")
            .state(TestState {
                count: 10,
                name: "test".into(),
            })
            .on_action::<AddPayload>("add", |state, payload, _ctx| {
                state.count += payload.amount;
            })
            .on_action::<()>("reset", |state, _, _ctx| {
                state.count = 0;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.mount();

        instance
            .dispatch_action("add", Some(serde_json::json!({"amount": 5})))
            .unwrap();
        assert_eq!(instance.get_state().count, 15);

        instance.dispatch_action("reset", None).unwrap();
        assert_eq!(instance.get_state().count, 0);
    }

    #[test]
    fn test_module_multiple_typed_actions() {
        #[derive(Deserialize)]
        struct AddPayload {
            amount: i32,
        }

        #[derive(Deserialize)]
        struct MultiplyPayload {
            factor: i32,
        }

        let def = ModuleBuilder::<TestState>::new("Mixed")
            .state(TestState {
                count: 10,
                name: "test".into(),
            })
            .on_action::<()>("reset", |state, _, _ctx| {
                state.count = 0;
            })
            .on_action::<AddPayload>("add", |state, payload, _ctx| {
                state.count += payload.amount;
            })
            .on_action::<MultiplyPayload>("multiply", |state, payload, _ctx| {
                state.count *= payload.factor;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.mount();

        instance.dispatch_action("reset", None).unwrap();
        assert_eq!(instance.get_state().count, 0);

        instance
            .dispatch_action("add", Some(serde_json::json!({"amount": 5})))
            .unwrap();
        assert_eq!(instance.get_state().count, 5);

        instance
            .dispatch_action("multiply", Some(serde_json::json!({"factor": 3})))
            .unwrap();
        assert_eq!(instance.get_state().count, 15);
    }

    #[test]
    #[should_panic(expected = "ModuleBuilder::state() must be called before build()")]
    fn test_module_builder_panics_without_state() {
        let _def = ModuleBuilder::<TestState>::new("Test").build();
    }

    #[test]
    fn test_module_invalid_ui_source() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .ui("this is not valid {{{{ hypen")
            .build();

        let result = ModuleInstance::new(Arc::new(def), None);
        assert!(result.is_err());
    }

    #[test]
    fn test_module_payload_type_mismatch_is_noop() {
        #[derive(Deserialize)]
        struct Expected {
            #[allow(dead_code)]
            value: i32,
        }

        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState {
                count: 42,
                name: "test".into(),
            })
            .on_action::<Expected>("set", |state, payload, _ctx| {
                state.count = payload.value;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.mount();

        // Send wrong payload shape — handler should silently skip
        instance
            .dispatch_action("set", Some(serde_json::json!("wrong type")))
            .unwrap();
        assert_eq!(instance.get_state().count, 42); // unchanged
    }

    #[test]
    fn test_module_duplicate_action_last_wins() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState {
                count: 0,
                name: "test".into(),
            })
            .on_action::<()>("act", |state, _, _ctx| {
                state.count += 1;
            })
            .on_action::<()>("act", |state, _, _ctx| {
                state.count += 100;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.dispatch_action("act", None).unwrap();
        assert_eq!(instance.get_state().count, 100); // second handler wins
    }

    #[test]
    fn test_module_ui_file() {
        let dir = std::env::temp_dir().join("hypen_test_ui_file");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("counter.hypen");
        std::fs::write(&path, r#"Column { Text("Hello") }"#).unwrap();

        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .ui_file(path.to_str().unwrap())
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None);
        assert!(instance.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_module_ui_file_not_found() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState::default())
            .ui_file("/tmp/hypen_no_such_file.hypen")
            .build();

        let result = ModuleInstance::new(Arc::new(def), None);
        assert!(result.is_err());
    }

    #[test]
    fn test_module_dispatch_without_mount() {
        let def = ModuleBuilder::<TestState>::new("Test")
            .state(TestState {
                count: 0,
                name: "test".into(),
            })
            .on_action::<()>("inc", |state, _, _ctx| {
                state.count += 1;
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        // Don't mount — dispatch should still work
        instance.dispatch_action("inc", None).unwrap();
        assert_eq!(instance.get_state().count, 1);
    }

    #[test]
    fn test_module_raw_json_action() {
        let def = ModuleBuilder::<TestState>::new("RawTest")
            .state(TestState {
                count: 0,
                name: "test".into(),
            })
            .on_action::<Value>("set_count", |state, payload, _ctx| {
                if let Some(n) = payload.as_i64() {
                    state.count = n as i32;
                }
            })
            .build();

        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
        instance.mount();

        instance
            .dispatch_action("set_count", Some(serde_json::json!(42)))
            .unwrap();
        assert_eq!(instance.get_state().count, 42);
    }

    #[test]
    fn test_nested_module_registers_in_context() {
        let ctx = Arc::new(GlobalContext::new());

        let def = Arc::new(
            ModuleBuilder::<TestState>::new("Feed")
                .state(TestState {
                    count: 0,
                    name: "feed".into(),
                })
                .build(),
        );

        let instance = create_nested_instance(def, ctx.clone()).unwrap();

        // Should be registered in context under lowercase name
        assert!(ctx.has_module("feed"));
        let state = ctx.get_module_state("feed").unwrap();
        assert_eq!(state["name"], "feed");

        instance.unmount();
    }

    #[test]
    fn test_nested_module_actions_work() {
        let ctx = Arc::new(GlobalContext::new());

        let def = Arc::new(
            ModuleBuilder::<TestState>::new("Counter")
                .state(TestState {
                    count: 0,
                    name: String::new(),
                })
                .on_action::<()>("increment", |state, _, _| {
                    state.count += 1;
                })
                .build(),
        );

        let instance = create_nested_instance(def, ctx.clone()).unwrap();
        instance.dispatch_action("increment", None).unwrap();
        assert_eq!(instance.get_state().count, 1);

        instance.unmount();
    }

    #[test]
    fn test_multiple_nested_modules() {
        let ctx = Arc::new(GlobalContext::new());

        let feed_def = Arc::new(
            ModuleBuilder::<TestState>::new("Feed")
                .state(TestState {
                    count: 0,
                    name: "feed".into(),
                })
                .build(),
        );
        let cart_def = Arc::new(
            ModuleBuilder::<TestState>::new("Cart")
                .state(TestState {
                    count: 5,
                    name: "cart".into(),
                })
                .build(),
        );

        let _feed = create_nested_instance(feed_def, ctx.clone()).unwrap();
        let _cart = create_nested_instance(cart_def, ctx.clone()).unwrap();

        assert!(ctx.has_module("feed"));
        assert!(ctx.has_module("cart"));
        assert_eq!(ctx.module_names().len(), 2);

        let global = ctx.global_state();
        assert_eq!(global["feed"]["name"], "feed");
        assert_eq!(global["cart"]["count"], 5);
    }

    #[test]
    fn test_new_with_components_resolves_child() {
        use crate::discovery::ComponentRegistry;

        let mut registry = ComponentRegistry::new();
        registry.register("Card", r#"Column { Text("Card content") }"#, None);

        let def = ModuleBuilder::<TestState>::new("Parent")
            .state(TestState {
                count: 0,
                name: "parent".into(),
            })
            // Template references the "Card" component
            .ui(r#"Column { Card {} }"#)
            .build();

        // With components — should succeed and resolve Card
        let instance =
            ModuleInstance::new_with_components(Arc::new(def), None, &registry).unwrap();
        instance.mount();
        assert_eq!(instance.get_state().name, "parent");
    }

    #[test]
    fn test_new_with_components_empty_registry() {
        use crate::discovery::ComponentRegistry;

        let registry = ComponentRegistry::new();

        let def = ModuleBuilder::<TestState>::new("Simple")
            .state(TestState::default())
            .ui(r#"Column { Text("Hello") }"#)
            .build();

        let instance =
            ModuleInstance::new_with_components(Arc::new(def), None, &registry).unwrap();
        instance.mount();
        assert!(instance.is_mounted());
    }

    /// Regression test: `new_with_components` must register `resource_map`
    /// with the engine, otherwise `Icon(@resources.xxx)` references are not
    /// resolved and renderers see the raw reference string. This mirrors the
    /// same bug that was present in the Go server's sendSessionAndInitialTree.
    #[test]
    fn test_new_with_components_registers_resources() {
        use crate::discovery::ComponentRegistry;

        let registry = ComponentRegistry::new();
        let heart_svg = r#"<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z" stroke="currentColor"/></svg>"#;

        let def = ModuleBuilder::<TestState>::new("WithIcons")
            .state(TestState::default())
            .ui(r#"Icon(@resources.heart)"#)
            .resource("heart", heart_svg)
            .build();

        let instance =
            ModuleInstance::new_with_components(Arc::new(def), None, &registry).unwrap();

        // Directly inspect the engine's resource registry — this is the
        // smoking-gun check for the fix. Before the fix, the registry was
        // empty here because new_with_components skipped the registration
        // loop that `new` has.
        let engine = instance.engine.lock().unwrap();
        let resolved = engine.resource_registry().resolve("heart");
        assert!(
            resolved.is_some(),
            "heart resource was not registered with the engine in new_with_components — \
             Icon(@resources.heart) would render as a raw reference string"
        );
        let data = resolved.unwrap();
        assert!(
            !data.paths.is_empty(),
            "resolved heart icon has no parsed paths"
        );
        assert!(
            data.paths[0].d.starts_with("M12 21"),
            "resolved heart path d did not round-trip: {:?}",
            data.paths[0].d
        );
    }

    // -----------------------------------------------------------------------
    // __hypen_bind two-way binding tests
    //
    // The `__hypen_bind` action is dispatched by renderers when a form
    // control's value changes. The SDK auto-handles it by writing the
    // payload's `value` into module state at the dotted `path`. See
    // ENGINE_CONTRACT.md §13 for the cross-SDK contract.
    // -----------------------------------------------------------------------

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    struct BindState {
        name: String,
        count: i32,
        nested: Nested,
    }

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    struct Nested {
        flag: bool,
    }

    #[test]
    fn test_hypen_bind_writes_value_at_path() {
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState::default())
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        instance
            .dispatch_action(
                "__hypen_bind",
                Some(serde_json::json!({"path": "name", "value": "Alice"})),
            )
            .unwrap();

        assert_eq!(instance.get_state().name, "Alice");
    }

    #[test]
    fn test_hypen_bind_writes_typed_number() {
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState::default())
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        instance
            .dispatch_action(
                "__hypen_bind",
                Some(serde_json::json!({"path": "count", "value": 42})),
            )
            .unwrap();

        assert_eq!(instance.get_state().count, 42);
    }

    #[test]
    fn test_hypen_bind_writes_nested_path() {
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState::default())
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        instance
            .dispatch_action(
                "__hypen_bind",
                Some(serde_json::json!({"path": "nested.flag", "value": true})),
            )
            .unwrap();

        assert!(instance.get_state().nested.flag);
    }

    #[test]
    fn test_hypen_bind_invalid_path_returns_error() {
        // Binding to a field that doesn't exist on the typed state should
        // surface as a state-serde error rather than silently corrupting state.
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState {
                name: "before".into(),
                count: 0,
                nested: Nested::default(),
            })
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        let result = instance.dispatch_action(
            "__hypen_bind",
            Some(serde_json::json!({"path": "name", "value": 42})), // wrong type for `name`
        );
        assert!(result.is_err(), "type-mismatched bind should fail");
        // State must be untouched on failure.
        assert_eq!(instance.get_state().name, "before");
    }

    #[test]
    fn test_hypen_bind_missing_path_returns_error() {
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState::default())
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        let result = instance.dispatch_action(
            "__hypen_bind",
            Some(serde_json::json!({"value": "missing path"})),
        );
        assert!(matches!(result, Err(SdkError::ActionPayload { .. })));
    }

    #[test]
    fn test_hypen_bind_missing_payload_returns_error() {
        let def = ModuleBuilder::<BindState>::new("BindTest")
            .state(BindState::default())
            .build();
        let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

        let result = instance.dispatch_action("__hypen_bind", None);
        assert!(matches!(result, Err(SdkError::ActionPayload { .. })));
    }

    // -----------------------------------------------------------------------
    // Async handler tests (behind "async" feature)
    // -----------------------------------------------------------------------

    #[cfg(feature = "async")]
    mod async_tests {
        use super::*;

        #[derive(Clone, Default, Serialize, Deserialize, Debug)]
        struct AsyncState {
            count: i32,
            name: String,
        }

        #[tokio::test]
        async fn test_async_action_handler() {
            let def = ModuleBuilder::<AsyncState>::new("AsyncTest")
                .state(AsyncState {
                    count: 0,
                    name: "test".into(),
                })
                .on_action_async::<()>("increment", |mut state, _, _ctx| {
                    Box::pin(async move {
                        state.count += 1;
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount();

            instance
                .dispatch_action_async("increment", None)
                .await
                .unwrap();
            assert_eq!(instance.get_state().count, 1);

            instance
                .dispatch_action_async("increment", None)
                .await
                .unwrap();
            assert_eq!(instance.get_state().count, 2);
        }

        #[tokio::test]
        async fn test_async_typed_payload() {
            #[derive(Deserialize)]
            struct AddPayload {
                amount: i32,
            }

            let def = ModuleBuilder::<AsyncState>::new("AsyncTyped")
                .state(AsyncState {
                    count: 10,
                    name: "test".into(),
                })
                .on_action_async::<AddPayload>("add", |mut state, payload, _ctx| {
                    Box::pin(async move {
                        state.count += payload.amount;
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount();

            instance
                .dispatch_action_async("add", Some(serde_json::json!({"amount": 5})))
                .await
                .unwrap();
            assert_eq!(instance.get_state().count, 15);
        }

        #[tokio::test]
        async fn test_async_falls_back_to_sync() {
            let def = ModuleBuilder::<AsyncState>::new("Fallback")
                .state(AsyncState {
                    count: 0,
                    name: "test".into(),
                })
                .on_action::<()>("sync_inc", |state, _, _ctx| {
                    state.count += 1;
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

            // dispatch_action_async should fall back to the sync handler
            instance
                .dispatch_action_async("sync_inc", None)
                .await
                .unwrap();
            assert_eq!(instance.get_state().count, 1);
        }

        #[tokio::test]
        async fn test_async_on_created() {
            let def = ModuleBuilder::<AsyncState>::new("AsyncCreated")
                .state(AsyncState {
                    count: 0,
                    name: "test".into(),
                })
                .on_created_async(|mut state, _ctx| {
                    Box::pin(async move {
                        state.count = 42;
                        state.name = "initialized".into();
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount_async().await;

            assert_eq!(instance.get_state().count, 42);
            assert_eq!(instance.get_state().name, "initialized");
        }

        #[tokio::test]
        async fn test_async_on_destroyed() {
            let destroyed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let destroyed_clone = destroyed.clone();

            let def = ModuleBuilder::<AsyncState>::new("AsyncDestroyed")
                .state(AsyncState {
                    count: 0,
                    name: "test".into(),
                })
                .on_destroyed_async(move |state, _ctx| {
                    let flag = destroyed_clone.clone();
                    Box::pin(async move {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount();
            assert!(!destroyed.load(std::sync::atomic::Ordering::SeqCst));

            instance.unmount_async().await;
            assert!(destroyed.load(std::sync::atomic::Ordering::SeqCst));
            assert!(!instance.is_mounted());
        }

        #[tokio::test]
        async fn test_async_mount_idempotent() {
            let call_count = Arc::new(std::sync::atomic::AtomicI32::new(0));
            let cc = call_count.clone();

            let def = ModuleBuilder::<AsyncState>::new("Idempotent")
                .state(AsyncState::default())
                .on_created_async(move |state, _ctx| {
                    let count = cc.clone();
                    Box::pin(async move {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount_async().await;
            instance.mount_async().await; // second call is noop

            assert_eq!(call_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn test_async_dispatch_unknown_action() {
            let def = ModuleBuilder::<AsyncState>::new("Unknown")
                .state(AsyncState::default())
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            let result = instance.dispatch_action_async("nonexistent", None).await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn test_async_mixed_sync_and_async_actions() {
            #[derive(Deserialize)]
            struct SetName {
                name: String,
            }

            let def = ModuleBuilder::<AsyncState>::new("Mixed")
                .state(AsyncState {
                    count: 0,
                    name: "init".into(),
                })
                .on_action::<()>("sync_inc", |state, _, _ctx| {
                    state.count += 1;
                })
                .on_action_async::<SetName>("async_set_name", |mut state, payload, _ctx| {
                    Box::pin(async move {
                        state.name = payload.name;
                        state
                    })
                })
                .build();

            let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
            instance.mount();

            // Use async dispatch for both sync and async handlers
            instance
                .dispatch_action_async("sync_inc", None)
                .await
                .unwrap();
            assert_eq!(instance.get_state().count, 1);

            instance
                .dispatch_action_async("async_set_name", Some(serde_json::json!({"name": "Alice"})))
                .await
                .unwrap();
            assert_eq!(instance.get_state().name, "Alice");
        }
    }
}
