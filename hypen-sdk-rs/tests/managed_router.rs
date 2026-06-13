//! Integration tests for [`ManagedRouter`].
//!
//! Mirrors `hypen-web/tests/named-state-registry-router.test.ts` and the
//! Swift / Kotlin equivalents: verifies route resolution, lifecycle order
//! (`on_created → on_activated`, `on_deactivated → on_destroyed`),
//! persistence (cache hit reuses the instance and skips `on_created`),
//! LRU eviction, and same-route navigation no-op.

use std::sync::{Arc, Mutex};

use hypen_server::context::GlobalContext;
use hypen_server::managed_router::{ManagedRouter, ManagedRouterOptions, RouteDefinition};
use hypen_server::prelude::*;
use hypen_server::router::HypenRouter;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
struct EmptyState {}

#[derive(Clone, Default)]
struct LifecycleLog {
    inner: Arc<Mutex<Vec<String>>>,
}

impl LifecycleLog {
    fn push(&self, s: impl Into<String>) {
        self.inner.lock().unwrap().push(s.into());
    }
    fn snapshot(&self) -> Vec<String> {
        self.inner.lock().unwrap().clone()
    }
}

/// Build a module that records every lifecycle hook into `log`.
///
/// The recorded prefix lets the assertion code distinguish each route's
/// events without having to inspect the instance.
fn make_def(name: &str, log: LifecycleLog) -> Arc<ModuleDefinition<EmptyState>> {
    let on_created = log.clone();
    let on_activated = log.clone();
    let on_deactivated = log.clone();
    let on_destroyed = log.clone();
    let n = name.to_string();
    let n_a = n.clone();
    let n_d = n.clone();
    let n_z = n.clone();
    Arc::new(
        ModuleBuilder::<EmptyState>::new(name)
            .state(EmptyState {})
            .ui(r#"Column { Text("hello") }"#)
            .on_created(move |_s, _ctx| on_created.push(format!("{n}:created")))
            .on_activated(move |_s, _ctx| on_activated.push(format!("{n_a}:activated")))
            .on_deactivated(move |_s, _ctx| on_deactivated.push(format!("{n_d}:deactivated")))
            .on_destroyed(move |_s, _ctx| on_destroyed.push(format!("{n_z}:destroyed")))
            .build(),
    )
}

/// Build a `RouteDefinition` whose factory instantiates `def` against the
/// shared `ctx`. Equivalent to the registry-lookup path the other SDKs
/// use; Rust just inlines the closure.
fn route(
    path: &str,
    component: &str,
    ctx: Arc<GlobalContext>,
    def: Arc<ModuleDefinition<EmptyState>>,
) -> RouteDefinition {
    RouteDefinition::factory(path, component, move || {
        let inst = ModuleInstance::new(Arc::clone(&def), Some(Arc::clone(&ctx)))?;
        Ok(Arc::new(inst) as Arc<dyn hypen_server::managed_router::ManagedModule>)
    })
}

#[test]
fn mounts_initial_route_on_start() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route(
        "/",
        "Home",
        Arc::clone(&ctx),
        make_def("Home", log.clone()),
    ));
    mr.start();

    assert_eq!(log.snapshot(), vec!["Home:created", "Home:activated"]);
    assert_eq!(mr.get_active_route_path(), Some("/".to_string()));
}

#[test]
fn nav_unmounts_previous_and_mounts_next() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route(
        "/",
        "Home",
        Arc::clone(&ctx),
        make_def("Home", log.clone()),
    ));
    mr.add_route(route(
        "/about",
        "About",
        Arc::clone(&ctx),
        make_def("About", log.clone()),
    ));
    mr.start();
    log.inner.lock().unwrap().clear();

    router.push("/about");

    // Previous route is destroyed (default persist=false), new one mounted.
    assert_eq!(
        log.snapshot(),
        vec![
            "Home:deactivated",
            "Home:destroyed",
            "About:created",
            "About:activated",
        ]
    );
    assert_eq!(mr.get_active_route_path(), Some("/about".to_string()));
}

#[test]
fn same_route_nav_is_noop() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route(
        "/",
        "Home",
        Arc::clone(&ctx),
        make_def("Home", log.clone()),
    ));
    mr.start();
    log.inner.lock().unwrap().clear();

    router.push("/");

    assert!(
        log.snapshot().is_empty(),
        "expected no lifecycle events for same-route nav"
    );
}

#[test]
fn persisted_route_skips_on_created_on_revisit() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route("/", "Home", Arc::clone(&ctx), make_def("Home", log.clone())).persist(true));
    mr.add_route(route(
        "/about",
        "About",
        Arc::clone(&ctx),
        make_def("About", log.clone()),
    ));
    mr.start();

    router.push("/about");
    log.inner.lock().unwrap().clear();

    router.push("/");

    // Cache hit: only Home:activated runs (not Home:created), and the
    // previously-active About is destroyed.
    assert_eq!(
        log.snapshot(),
        vec!["About:deactivated", "About:destroyed", "Home:activated",]
    );
}

#[test]
fn unmatched_path_clears_active_module() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route(
        "/",
        "Home",
        Arc::clone(&ctx),
        make_def("Home", log.clone()),
    ));
    mr.start();
    log.inner.lock().unwrap().clear();

    router.push("/nope");

    assert_eq!(log.snapshot(), vec!["Home:deactivated", "Home:destroyed"]);
    assert!(mr.get_active_module().is_none());
    assert_eq!(mr.get_active_route_path(), None);
}

#[test]
fn lru_evicts_least_recently_used_persisted_module() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions {
            max_persisted_modules: 2,
            default_persist: true,
        },
    );
    mr.add_route(route(
        "/a",
        "A",
        Arc::clone(&ctx),
        make_def("A", log.clone()),
    ));
    mr.add_route(route(
        "/b",
        "B",
        Arc::clone(&ctx),
        make_def("B", log.clone()),
    ));
    mr.add_route(route(
        "/c",
        "C",
        Arc::clone(&ctx),
        make_def("C", log.clone()),
    ));

    router.push("/a");
    mr.start(); // initial route is /a
    router.push("/b"); // /a → cache (lru: [a])
    router.push("/c"); // /b → cache (lru: [a, b])
                       // Active = C; cache = [a, b]; cap = 2.

    log.inner.lock().unwrap().clear();
    router.push("/a"); // cache hit on a → lru: [b], active=A; C deactivated+destroyed (no persist? default=true)
                       // Actually default_persist=true so C is cached; lru becomes [b, c], a was removed.

    let snap = log.snapshot();
    // C deactivates + caches; A activates from cache.
    assert!(snap.contains(&"C:deactivated".to_string()));
    assert!(snap.contains(&"A:activated".to_string()));
    assert!(
        !snap.contains(&"A:created".to_string()),
        "A should restore from cache"
    );

    // Now push /a again — already active, no-op.
    log.inner.lock().unwrap().clear();
    router.push("/a");
    assert!(log.snapshot().is_empty());

    // Push /c: cache hit. After this, lru should be [b, c] before the
    // hit removes c; with cap=2, no eviction.
    log.inner.lock().unwrap().clear();
    router.push("/c");
    let snap = log.snapshot();
    assert!(snap.contains(&"C:activated".to_string()));
    assert!(
        !snap.contains(&"C:created".to_string()),
        "C should restore from cache"
    );
}

#[test]
fn stop_destroys_active_and_persisted_modules() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions {
            max_persisted_modules: 4,
            default_persist: true,
        },
    );
    mr.add_route(route(
        "/",
        "Home",
        Arc::clone(&ctx),
        make_def("Home", log.clone()),
    ));
    mr.add_route(route(
        "/a",
        "A",
        Arc::clone(&ctx),
        make_def("A", log.clone()),
    ));
    mr.start();
    router.push("/a"); // Home cached, A active

    log.inner.lock().unwrap().clear();
    mr.stop();

    let snap = log.snapshot();
    // Active A: deactivate + destroy. Cached Home: destroy only.
    assert!(snap.contains(&"A:deactivated".to_string()));
    assert!(snap.contains(&"A:destroyed".to_string()));
    assert!(snap.contains(&"Home:destroyed".to_string()));
    assert!(mr.get_active_module().is_none());
    assert!(mr.persisted_keys().is_empty());
}

#[test]
fn route_param_match() {
    let log = LifecycleLog::default();
    let ctx = Arc::new(GlobalContext::new());
    let router = Arc::new(HypenRouter::new());
    let mr = ManagedRouter::new(
        Arc::clone(&router),
        Arc::clone(&ctx),
        ManagedRouterOptions::default(),
    );
    mr.add_route(route(
        "/users/:id",
        "User",
        Arc::clone(&ctx),
        make_def("User", log.clone()),
    ));
    mr.start(); // initial / does not match — no mount
    assert!(log.snapshot().is_empty());

    router.push("/users/42");
    assert_eq!(mr.get_active_route_path(), Some("/users/:id".to_string()));
    assert_eq!(log.snapshot(), vec!["User:created", "User:activated"]);
}
