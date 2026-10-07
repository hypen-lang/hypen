//! Managed router — orchestrates module mount/unmount on route changes.
//!
//! A [`ManagedRouter`] subscribes to a [`HypenRouter`] and rotates a single
//! "active module" through the engine as the URL changes. It mirrors the
//! TS / Go / Swift / Kotlin implementations:
//!
//! * First visit to a route: `instance constructed → on_activated`.
//! * Navigate away: `on_deactivated` → (persist OR `on_destroyed`).
//! * Revisit (persisted): `on_activated` (the constructor / `on_created`
//!   does not re-run because the cached instance is reused).
//!
//! ## How Rust differs from the other SDKs
//!
//! TS/Go/Swift/Kotlin look up `RouteDefinition.component` against a global
//! `HypenApp` registry of `name → ModuleDefinition`. The Rust SDK doesn't
//! carry a type-erased registry of typed `ModuleDefinition<S>`s, so each
//! [`RouteDefinition`] here owns a **factory** that constructs the module
//! on demand. The factory returns an [`Arc<dyn ManagedModule>`] — a
//! type-erased trait object — which the router then activates / persists /
//! destroys.
//!
//! `ModuleInstance<S>` implements [`ManagedModule`] for any `S: State`, so
//! a typical site looks like:
//!
//! ```ignore
//! let app = Arc::new(HypenApp::default());
//! let def = Arc::new(HypenApp::module::<HomeState>("Home")
//!     .state(HomeState::default())
//!     .ui(...)
//!     .build());
//!
//! let mut router = ManagedRouter::new(
//!     app.router_arc(),
//!     Arc::clone(app.context_arc()),
//!     ManagedRouterOptions::default(),
//! );
//! router.add_route(RouteDefinition::factory("/", "Home", {
//!     let app = Arc::clone(&app);
//!     let def = Arc::clone(&def);
//!     move || {
//!         let inst = app.instantiate(Arc::clone(&def))?;
//!         Ok(Arc::new(inst) as Arc<dyn ManagedModule>)
//!     }
//! }));
//! router.start();
//! ```

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::context::GlobalContext;
use crate::error::Result;
use crate::events::SubscriptionId;
use crate::module::ModuleInstance;
use crate::router::HypenRouter;
use crate::state::State;

/// Default LRU cap for the persist cache. Matches every other SDK
/// (`DEFAULT_ROUTER_CACHE_SIZE` in the engine).
pub const DEFAULT_PERSIST_CAP: usize = 10;

/// Type-erased module handle managed by [`ManagedRouter`].
///
/// Implemented for [`ModuleInstance<S>`] for every `S: State`; users with
/// custom module shells can implement it themselves to participate in
/// route-driven lifecycle.
pub trait ManagedModule: Send + Sync {
    fn name(&self) -> &str;
    fn mount(&self);
    fn activate(&self);
    fn deactivate(&self);
    fn destroy(&self);
    /// Release the module's externally reachable surface — the actions an
    /// external caller (MCP, REST, CLI, agent) may dispatch by name.
    ///
    /// **Called at destroy sites only**, never on plain unmount: an
    /// off-screen persisted module stays registered on purpose so siblings
    /// can keep reading its state, and dropping it there would break both
    /// the persist cache and those cross-module reads. See
    /// [`ModuleInstance::unregister_external`].
    ///
    /// Defaults to a no-op so custom module shells that don't own an engine
    /// registration need not implement it.
    fn unregister_external(&self) {}
    /// Whether this module's definition opted into persistence.
    /// Defaults to `false` — match the TS / Swift contract where
    /// persistence is opt-in via `.persist()`.
    fn is_persistent(&self) -> bool {
        false
    }
}

impl<S: State> ManagedModule for ModuleInstance<S> {
    fn name(&self) -> &str {
        ModuleInstance::name(self)
    }
    fn mount(&self) {
        ModuleInstance::mount(self)
    }
    fn activate(&self) {
        ModuleInstance::activate(self)
    }
    fn deactivate(&self) {
        ModuleInstance::deactivate(self)
    }
    fn destroy(&self) {
        ModuleInstance::unmount(self)
    }
    fn unregister_external(&self) {
        ModuleInstance::unregister_external(self)
    }
    fn is_persistent(&self) -> bool {
        // Reach into the definition via the public `is_mounted` accessor's
        // sibling — `ModuleInstance` doesn't expose `definition` publicly,
        // so we mirror the persist flag through the trait at registration
        // time by leaning on `ModuleDefinition::is_persistent`. That's
        // enforced by the `RouteDefinition::persist` override below; this
        // default just reports `false` and is overridden when the route
        // explicitly opts in.
        false
    }
}

/// Factory closure that constructs a fresh [`ManagedModule`] on demand.
///
/// `ManagedRouter` calls this every time a route mounts and there is no
/// persisted instance to restore. Returning `Err` propagates through
/// `handle_route_change` and leaves the router in the "no active module"
/// state for the failed route — same as the other SDKs when a definition
/// can't be resolved.
pub type ModuleFactory = Arc<dyn Fn() -> Result<Arc<dyn ManagedModule>> + Send + Sync>;

/// A single route entry registered with [`ManagedRouter`].
pub struct RouteDefinition {
    /// Path pattern (`/`, `/users/:id`, `/api/*`).
    pub path: String,
    /// Component name — used as the persist-cache key (lowercased) and
    /// surfaced in logs / `get_active_route()` for symmetry with the
    /// other SDKs.
    pub component: String,
    /// Factory that builds a fresh module instance.
    pub factory: ModuleFactory,
    /// Whether the instance should be cached on `unmount` and reused on
    /// revisit. `None` = inherit the [`ManagedRouter`]'s default
    /// (currently `false`); `Some(true|false)` = explicit override.
    pub persist: Option<bool>,
}

impl RouteDefinition {
    /// Convenience constructor with the factory passed inline.
    pub fn factory<F>(path: impl Into<String>, component: impl Into<String>, f: F) -> Self
    where
        F: Fn() -> Result<Arc<dyn ManagedModule>> + Send + Sync + 'static,
    {
        Self {
            path: path.into(),
            component: component.into(),
            factory: Arc::new(f),
            persist: None,
        }
    }

    /// Override the router's default persist behavior for this route.
    pub fn persist(mut self, persist: bool) -> Self {
        self.persist = Some(persist);
        self
    }

    fn cache_key(&self) -> String {
        self.component.to_lowercase()
    }
}

/// Tunables for [`ManagedRouter`]. Mirrors `ManagedRouterOptions` in the
/// other SDKs.
#[derive(Debug, Clone)]
pub struct ManagedRouterOptions {
    /// LRU cap on the persist cache. Once exceeded, the
    /// least-recently-used entry is destroyed to make room. Defaults to
    /// [`DEFAULT_PERSIST_CAP`].
    pub max_persisted_modules: usize,
    /// Default `persist` value when [`RouteDefinition::persist`] is
    /// `None`. Matches the TS contract: opt-in (`false`).
    pub default_persist: bool,
}

impl Default for ManagedRouterOptions {
    fn default() -> Self {
        Self {
            max_persisted_modules: DEFAULT_PERSIST_CAP,
            default_persist: false,
        }
    }
}

struct State_ {
    routes: Vec<RouteDefinition>,
    active: Option<(usize, Arc<dyn ManagedModule>)>,
    persisted: HashMap<String, Arc<dyn ManagedModule>>,
    /// Most-recently-used last. Kept in lock-step with `persisted`.
    lru: VecDeque<String>,
    unsub: Option<SubscriptionId>,
}

/// Orchestrates module mount/unmount on route changes.
///
/// See the module-level docs for the high-level lifecycle. Hold via
/// `Arc<ManagedRouter>` if multiple owners need to drive it
/// (`router.on_navigate` will keep an internal clone alive).
pub struct ManagedRouter {
    router: Arc<HypenRouter>,
    global_context: Arc<GlobalContext>,
    options: ManagedRouterOptions,
    inner: Arc<Mutex<State_>>,
}

impl ManagedRouter {
    pub fn new(
        router: Arc<HypenRouter>,
        global_context: Arc<GlobalContext>,
        options: ManagedRouterOptions,
    ) -> Self {
        Self {
            router,
            global_context,
            options,
            inner: Arc::new(Mutex::new(State_ {
                routes: Vec::new(),
                active: None,
                persisted: HashMap::new(),
                lru: VecDeque::new(),
                unsub: None,
            })),
        }
    }

    pub fn add_route(&self, route: RouteDefinition) -> &Self {
        self.inner.lock().unwrap().routes.push(route);
        self
    }

    /// Subscribe to the underlying router and mount the initial route.
    ///
    /// Idempotent — calling `start()` a second time without `stop()` is a
    /// no-op (the existing subscription stays).
    pub fn start(&self) {
        // Subscribe first so any nav fired between this and the initial
        // mount is observed.
        {
            let mut g = self.inner.lock().unwrap();
            if g.unsub.is_some() {
                return;
            }
            let inner = Arc::clone(&self.inner);
            let router = Arc::clone(&self.router);
            let context = Arc::clone(&self.global_context);
            let options = self.options.clone();
            let sub = self.router.on_navigate(move |_payload| {
                let path = router.current_path();
                handle_route_change(&inner, &context, &options, &path);
            });
            g.unsub = Some(sub);
        }
        let path = self.router.current_path();
        handle_route_change(&self.inner, &self.global_context, &self.options, &path);
    }

    /// Unsubscribe and tear down both the active and persisted modules.
    pub fn stop(&self) {
        let (active, persisted, sub) = {
            let mut g = self.inner.lock().unwrap();
            let active = g.active.take().map(|(_, m)| m);
            let persisted: Vec<_> = g.persisted.drain().collect();
            g.lru.clear();
            (active, persisted, g.unsub.take())
        };
        if let Some(sub) = sub {
            self.router.off(sub);
        }
        if let Some(m) = active {
            m.deactivate();
            m.destroy();
            m.unregister_external();
            self.global_context
                .unregister_module(&m.name().to_lowercase());
        }
        // `stop()` is a full teardown, so the persisted entries are being
        // destroyed too — this is the one place a cached module loses its
        // external surface.
        for (key, m) in persisted {
            m.destroy();
            m.unregister_external();
            self.global_context.unregister_module(&key);
        }
    }

    pub fn get_active_module(&self) -> Option<Arc<dyn ManagedModule>> {
        self.inner
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(|(_, m)| Arc::clone(m))
    }

    pub fn get_active_route_path(&self) -> Option<String> {
        let g = self.inner.lock().unwrap();
        g.active
            .as_ref()
            .map(|(idx, _)| g.routes[*idx].path.clone())
    }

    /// Snapshot of currently-cached module keys (lowercase). Test-only
    /// helper — exposed because the persist cache is otherwise private.
    pub fn persisted_keys(&self) -> Vec<String> {
        self.inner.lock().unwrap().lru.iter().cloned().collect()
    }
}

impl Drop for ManagedRouter {
    fn drop(&mut self) {
        // Best-effort teardown so subscriptions don't outlive the router.
        if self.inner.lock().unwrap().unsub.is_some() {
            self.stop();
        }
    }
}

fn handle_route_change(
    inner: &Arc<Mutex<State_>>,
    global_context: &Arc<GlobalContext>,
    options: &ManagedRouterOptions,
    path: &str,
) {
    // Route resolution — done under lock against a snapshot of the
    // routes vec to avoid holding the lock across factory invocation.
    let matched_idx = {
        let g = inner.lock().unwrap();
        g.routes
            .iter()
            .position(|r| hypen_engine::match_path(&r.path, path).is_some())
    };

    let Some(idx) = matched_idx else {
        unmount_active(inner, global_context, options);
        return;
    };

    // Same-route nav is a no-op.
    {
        let g = inner.lock().unwrap();
        if let Some((active_idx, _)) = &g.active {
            if *active_idx == idx {
                return;
            }
        }
    }

    // Pull the target from cache *before* unmounting the previous route.
    // Otherwise, when the previous route is itself persisted and the
    // cache is at capacity, the LRU eviction in `unmount_active` would
    // evict the very entry we're about to restore — silently turning
    // the cache hit into a fresh construction.
    let preloaded = {
        let mut g = inner.lock().unwrap();
        let key = g.routes[idx].cache_key();
        g.persisted.remove(&key).map(|m| {
            g.lru.retain(|k| k != &key);
            m
        })
    };
    unmount_active(inner, global_context, options);
    mount_route(inner, global_context, idx, preloaded);
}

fn mount_route(
    inner: &Arc<Mutex<State_>>,
    global_context: &Arc<GlobalContext>,
    idx: usize,
    preloaded: Option<Arc<dyn ManagedModule>>,
) {
    // Decide cache-hit vs. fresh construction under lock. The factory
    // (which may do non-trivial work) always runs outside the lock.
    enum Plan {
        Hit(Arc<dyn ManagedModule>),
        Miss { key: String, factory: ModuleFactory },
    }
    let plan = if let Some(m) = preloaded {
        Plan::Hit(m)
    } else {
        let g = inner.lock().unwrap();
        let key = g.routes[idx].cache_key();
        let factory = Arc::clone(&g.routes[idx].factory);
        Plan::Miss { key, factory }
    };

    let module = match plan {
        Plan::Hit(m) => {
            // Cache hit — re-record the GlobalContext registration was
            // never removed (persist branch in unmount keeps it), so we
            // only need to flip the active slot.
            let mut g = inner.lock().unwrap();
            g.active = Some((idx, Arc::clone(&m)));
            drop(g);
            m.activate();
            return;
        }
        Plan::Miss { key, factory } => match (factory)() {
            Ok(m) => {
                // Register in GlobalContext (matches every other SDK —
                // siblings can read this module's state via
                // `context.get_module_state(name)`).
                global_context.register_module_state(&key, serde_json::Value::Null);
                let mut g = inner.lock().unwrap();
                g.active = Some((idx, Arc::clone(&m)));
                drop(g);
                m
            }
            Err(e) => {
                // Mirror Swift / Kotlin: log and clear the active slot.
                // No `log` crate dep here, so use stderr.
                eprintln!(
                    "[hypen-server] managed_router: factory for component '{}' failed: {e}",
                    key_for_idx(inner, idx)
                );
                let mut g = inner.lock().unwrap();
                g.active = None;
                return;
            }
        },
    };

    // First-time mount: fire on_created (via `mount`) then on_activated.
    module.mount();
    module.activate();
}

fn unmount_active(
    inner: &Arc<Mutex<State_>>,
    global_context: &Arc<GlobalContext>,
    options: &ManagedRouterOptions,
) {
    let prev = {
        let mut g = inner.lock().unwrap();
        g.active.take()
    };
    let Some((idx, module)) = prev else { return };

    // Resolve the route's persist flag (route override > router default).
    let (key, persist) = {
        let g = inner.lock().unwrap();
        let route = &g.routes[idx];
        (
            route.cache_key(),
            route.persist.unwrap_or(options.default_persist),
        )
    };

    // Always deactivate first — `on_deactivated` runs before either path.
    module.deactivate();

    if persist {
        // Cache + LRU bookkeeping. If we're at cap, evict the LRU entry
        // (oldest) and destroy it.
        let mut evictees: Vec<(String, Arc<dyn ManagedModule>)> = Vec::new();
        {
            let mut g = inner.lock().unwrap();
            g.persisted.insert(key.clone(), module);
            // Refresh recency: drop old entry then push.
            g.lru.retain(|k| k != &key);
            g.lru.push_back(key.clone());
            while g.lru.len() > options.max_persisted_modules {
                if let Some(oldest) = g.lru.pop_front() {
                    if let Some(m) = g.persisted.remove(&oldest) {
                        evictees.push((oldest, m));
                    }
                }
            }
        }
        // Evicted entries are destroyed, not merely parked, so their
        // external surface goes with them. The entries still in the cache
        // keep theirs — see the note below.
        for (k, m) in evictees {
            m.destroy();
            m.unregister_external();
            global_context.unregister_module(&k);
        }
    } else {
        // Destroy path only. Note the asymmetry with the `persist` branch
        // above, which deliberately calls neither: a persisted module is
        // off-screen, not gone, and stays registered so sibling modules can
        // still read its state and so a revisit reuses the instance.
        module.destroy();
        module.unregister_external();
        global_context.unregister_module(&key);
    }
}

fn key_for_idx(inner: &Arc<Mutex<State_>>, idx: usize) -> String {
    inner
        .lock()
        .unwrap()
        .routes
        .get(idx)
        .map(|r| r.cache_key())
        .unwrap_or_default()
}
