//! Integration tests for hypen-server SDK.
//!
//! These tests exercise end-to-end flows: build module -> mount -> dispatch
//! actions -> verify state & patches.

use std::sync::{Arc, Mutex};

use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

// ---------------------------------------------------------------------------
// Shared state types
// ---------------------------------------------------------------------------

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
struct CounterState {
    count: i32,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
struct TodoState {
    items: Vec<TodoItem>,
    filter: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
struct TodoItem {
    id: String,
    text: String,
    done: bool,
}

// ---------------------------------------------------------------------------
// Basic flow: build, mount, dispatch, verify state
// ---------------------------------------------------------------------------

#[test]
fn test_counter_full_lifecycle() {
    let def = ModuleBuilder::<CounterState>::new("Counter")
        .state(CounterState { count: 0 })
        .ui(r#"Column { Text("Count: @{state.count}") }"#)
        .on_action::<()>("increment", |state, _, _| {
            state.count += 1;
        })
        .on_action::<()>("decrement", |state, _, _| {
            state.count -= 1;
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.mount();
    assert!(instance.is_mounted());

    // Increment 3 times
    for _ in 0..3 {
        instance.dispatch_action("increment", None).unwrap();
    }
    assert_eq!(instance.get_state().count, 3);

    // Decrement once
    instance.dispatch_action("decrement", None).unwrap();
    assert_eq!(instance.get_state().count, 2);

    instance.unmount();
    assert!(!instance.is_mounted());
}

// ---------------------------------------------------------------------------
// Regression: on_action::<()> must fire even when the renderer dispatches
// a non-null payload. The DOM renderer attaches a MouseEvent snapshot to
// every click (`{type: "click", clientX, clientY, button, timestamp}`) —
// even when the DSL `.onClick(@actions.X)` had no explicit args. Previously
// `from_value::<()>(click_event)` failed and the handler was silently
// dropped, so payload-less actions like `placeOrder` / `toggleFavorite`
// never ran.
// ---------------------------------------------------------------------------

#[test]
fn test_unit_action_tolerates_renderer_payload() {
    let def = ModuleBuilder::<CounterState>::new("Counter")
        .state(CounterState { count: 0 })
        .on_action::<()>("placeOrder", |state, _, _| {
            state.count += 1;
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.mount();

    // Exactly the payload the DOM renderer sends for `.onClick(@actions.X)`
    // when the DSL author wrote no custom args.
    let click_payload = json!({
        "type": "click",
        "timestamp": 1_700_000_000u64,
        "clientX": 100,
        "clientY": 200,
        "button": 0,
    });

    instance
        .dispatch_action("placeOrder", Some(click_payload))
        .unwrap();

    assert_eq!(
        instance.get_state().count,
        1,
        "on_action::<()> must fire despite the MouseEvent snapshot payload",
    );

    // No payload still works (fallback to Null).
    instance.dispatch_action("placeOrder", None).unwrap();
    assert_eq!(instance.get_state().count, 2);
}

// ---------------------------------------------------------------------------
// Typed payloads across multiple action types
// ---------------------------------------------------------------------------

#[test]
fn test_todo_app_flow() {
    #[derive(Deserialize)]
    struct AddItem {
        id: String,
        text: String,
    }

    #[derive(Deserialize)]
    struct ToggleItem {
        id: String,
    }

    #[derive(Deserialize)]
    struct SetFilter {
        filter: String,
    }

    let def = ModuleBuilder::<TodoState>::new("TodoApp")
        .state(TodoState {
            items: vec![],
            filter: "all".into(),
        })
        .on_action::<AddItem>("add", |state, payload, _| {
            state.items.push(TodoItem {
                id: payload.id,
                text: payload.text,
                done: false,
            });
        })
        .on_action::<ToggleItem>("toggle", |state, payload, _| {
            if let Some(item) = state.items.iter_mut().find(|i| i.id == payload.id) {
                item.done = !item.done;
            }
        })
        .on_action::<SetFilter>("setFilter", |state, payload, _| {
            state.filter = payload.filter;
        })
        .on_action::<()>("clearCompleted", |state, _, _| {
            state.items.retain(|i| !i.done);
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.mount();

    // Add items
    instance
        .dispatch_action("add", Some(json!({"id": "1", "text": "Buy milk"})))
        .unwrap();
    instance
        .dispatch_action("add", Some(json!({"id": "2", "text": "Write tests"})))
        .unwrap();
    assert_eq!(instance.get_state().items.len(), 2);

    // Toggle item
    instance
        .dispatch_action("toggle", Some(json!({"id": "1"})))
        .unwrap();
    assert!(instance.get_state().items[0].done);
    assert!(!instance.get_state().items[1].done);

    // Set filter
    instance
        .dispatch_action("setFilter", Some(json!({"filter": "active"})))
        .unwrap();
    assert_eq!(instance.get_state().filter, "active");

    // Clear completed
    instance.dispatch_action("clearCompleted", None).unwrap();
    assert_eq!(instance.get_state().items.len(), 1);
    assert_eq!(instance.get_state().items[0].id, "2");
}

// ---------------------------------------------------------------------------
// Patch collection: verify engine emits patches on state change
// ---------------------------------------------------------------------------

#[test]
fn test_patches_emitted_on_state_change() {
    let patches: Arc<Mutex<Vec<Vec<Patch>>>> = Arc::new(Mutex::new(vec![]));
    let patches_clone = patches.clone();

    let def = ModuleBuilder::<CounterState>::new("PatchTest")
        .state(CounterState { count: 0 })
        .ui(r#"Text("@{state.count}")"#)
        .on_action::<()>("increment", |state, _, _| {
            state.count += 1;
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();

    // Register patch callback (after construction, so initial render is not captured)
    instance.on_patches(move |p| {
        patches_clone.lock().unwrap().push(p.to_vec());
    });

    instance.mount();

    // Dispatch action — this should produce patches (setProp for updated text)
    instance.dispatch_action("increment", None).unwrap();
    let after_dispatch = patches.lock().unwrap().len();
    assert!(after_dispatch > 0, "State change should produce patches");
}

// ---------------------------------------------------------------------------
// Global context: share data between modules
// ---------------------------------------------------------------------------

#[test]
fn test_global_context_shared_between_modules() {
    let ctx = Arc::new(GlobalContext::new());
    ctx.register_module_state("theme_config", json!({"theme": "dark"}));

    let def1 = ModuleBuilder::<CounterState>::new("ModuleA")
        .state(CounterState { count: 0 })
        .on_created(|_state, ctx| {
            if let Some(ctx) = ctx {
                let state = ctx.get_module_state("theme_config").unwrap();
                assert_eq!(state["theme"], "dark");
            }
        })
        .build();

    let def2 = ModuleBuilder::<CounterState>::new("ModuleB")
        .state(CounterState { count: 0 })
        .on_created(|_state, ctx| {
            if let Some(ctx) = ctx {
                assert!(ctx.has_module("theme_config"));
            }
        })
        .build();

    let inst1 = ModuleInstance::new(Arc::new(def1), Some(ctx.clone())).unwrap();
    let inst2 = ModuleInstance::new(Arc::new(def2), Some(ctx.clone())).unwrap();

    inst1.mount();
    inst2.mount();
}

// ---------------------------------------------------------------------------
// Lifecycle ordering: on_created before dispatch, on_destroyed after
// ---------------------------------------------------------------------------

#[test]
fn test_lifecycle_ordering() {
    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let e1 = events.clone();
    let e2 = events.clone();
    let e3 = events.clone();

    let def = ModuleBuilder::<CounterState>::new("LifecycleOrder")
        .state(CounterState { count: 0 })
        .on_created(move |_, _| {
            e1.lock().unwrap().push("created".into());
        })
        .on_action::<()>("act", move |state, _, _| {
            e2.lock().unwrap().push("action".into());
            state.count += 1;
        })
        .on_destroyed(move |_, _| {
            e3.lock().unwrap().push("destroyed".into());
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.mount();
    instance.dispatch_action("act", None).unwrap();
    instance.unmount();

    let log = events.lock().unwrap();
    assert_eq!(*log, vec!["created", "action", "destroyed"]);
}

// ---------------------------------------------------------------------------
// State JSON roundtrip
// ---------------------------------------------------------------------------

#[test]
fn test_state_json_roundtrip() {
    let def = ModuleBuilder::<TodoState>::new("JsonRT")
        .state(TodoState {
            items: vec![TodoItem {
                id: "1".into(),
                text: "Test".into(),
                done: false,
            }],
            filter: "all".into(),
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    let json = instance.get_state_json().unwrap();

    assert_eq!(json["filter"], "all");
    assert_eq!(json["items"][0]["text"], "Test");
    assert_eq!(json["items"][0]["done"], false);
}

// ---------------------------------------------------------------------------
// Error: unknown action
// ---------------------------------------------------------------------------

#[test]
fn test_dispatch_unknown_action_returns_error() {
    let def = ModuleBuilder::<CounterState>::new("ErrTest")
        .state(CounterState { count: 0 })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    let result = instance.dispatch_action("nope", None);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Router integration
// ---------------------------------------------------------------------------

#[test]
fn test_router_pattern_matching() {
    let router = HypenRouter::new();

    // Navigate and check state
    router.push("/counter");
    assert_eq!(router.current_path(), "/counter");

    // Match patterns
    let m = router.match_path("/counter", "/counter");
    assert!(m.is_some());

    let m = router.match_path("/profile/:id", "/profile/42").unwrap();
    assert_eq!(m.params["id"], "42");

    // Wildcard
    assert!(router.match_path("/api/*", "/api/users/list").is_some());
    assert!(router.match_path("/api/*", "/other").is_none());
}

// ---------------------------------------------------------------------------
// Component discovery
// ---------------------------------------------------------------------------

#[test]
fn test_component_discovery() {
    let dir = std::env::temp_dir().join("hypen_integration_test_discovery");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Header.hypen"), r#"Text("Header")"#).unwrap();
    std::fs::write(dir.join("Footer.hypen"), r#"Text("Footer")"#).unwrap();

    let mut registry = ComponentRegistry::new();
    let loaded = registry.load_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(loaded.len(), 2);
    assert!(registry.get("Header").is_some());
    assert!(registry.get("Footer").is_some());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// HypenApp builder: full app assembly
// ---------------------------------------------------------------------------

#[test]
fn test_hypen_app_builder() {
    let counter_def = ModuleBuilder::<CounterState>::new("Counter")
        .state(CounterState { count: 0 })
        .on_action::<()>("increment", |state, _, _| {
            state.count += 1;
        })
        .build();

    let app = HypenApp::builder().route("/", counter_def).build();

    assert!(app.match_route("/").is_some());
}

// ---------------------------------------------------------------------------
// HypenApp instantiate + dispatch
// ---------------------------------------------------------------------------

#[test]
fn test_app_instantiate_and_dispatch() {
    let app = HypenApp::default();

    let def = ModuleBuilder::<CounterState>::new("Counter")
        .state(CounterState { count: 0 })
        .on_action::<()>("increment", |state, _, _| {
            state.count += 1;
        })
        .build();

    let instance = app.instantiate(Arc::new(def)).unwrap();
    instance.mount();

    instance.dispatch_action("increment", None).unwrap();
    instance.dispatch_action("increment", None).unwrap();
    assert_eq!(instance.get_state().count, 2);
}

// ---------------------------------------------------------------------------
// Multiple modules sharing global context
// ---------------------------------------------------------------------------

#[test]
fn test_multi_module_via_global_context() {
    let ctx = Arc::new(GlobalContext::new());

    let def_a = ModuleBuilder::<CounterState>::new("A")
        .state(CounterState { count: 0 })
        .on_action::<()>("increment_and_sync", |state, _, ctx| {
            state.count += 1;
            if let Some(ctx) = ctx {
                ctx.register_module_state("A", json!({"count": state.count}));
            }
        })
        .build();

    let def_b = ModuleBuilder::<CounterState>::new("B")
        .state(CounterState { count: 0 })
        .on_action::<()>("read_global", |state, _, ctx| {
            if let Some(ctx) = ctx {
                if let Some(val) = ctx.get_module_state("A") {
                    state.count = val["count"].as_i64().unwrap_or(0) as i32;
                }
            }
        })
        .build();

    let inst_a = ModuleInstance::new(Arc::new(def_a), Some(ctx.clone())).unwrap();
    let inst_b = ModuleInstance::new(Arc::new(def_b), Some(ctx.clone())).unwrap();
    inst_a.mount();
    inst_b.mount();

    // Module A increments 5 times, syncing to global each time
    for _ in 0..5 {
        inst_a.dispatch_action("increment_and_sync", None).unwrap();
    }

    // Module B reads from global
    inst_b.dispatch_action("read_global", None).unwrap();
    assert_eq!(inst_b.get_state().count, 5);
}

// ---------------------------------------------------------------------------
// UI file loading from disk
// ---------------------------------------------------------------------------

#[test]
fn test_ui_file_integration() {
    let dir = std::env::temp_dir().join("hypen_integration_ui_file");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let path = dir.join("counter.hypen");
    std::fs::write(&path, r#"Column { Text("Count: @{state.count}") }"#).unwrap();

    let def = ModuleBuilder::<CounterState>::new("FileModule")
        .state(CounterState { count: 0 })
        .ui_file(path.to_str().unwrap())
        .on_action::<()>("increment", |state, _, _| {
            state.count += 1;
        })
        .build();

    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.mount();
    instance.dispatch_action("increment", None).unwrap();
    assert_eq!(instance.get_state().count, 1);

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// Persist flag
// ---------------------------------------------------------------------------

#[test]
fn test_persist_flag_propagates() {
    let def = ModuleBuilder::<CounterState>::new("Persistent")
        .state(CounterState { count: 0 })
        .persist()
        .build();

    assert!(def.is_persistent());

    let non_persist = ModuleBuilder::<CounterState>::new("Ephemeral")
        .state(CounterState { count: 0 })
        .build();

    assert!(!non_persist.is_persistent());
}

// ---------------------------------------------------------------------------
// Event emitter
// ---------------------------------------------------------------------------

#[test]
fn test_event_emitter_cross_module() {
    let emitter = EventEmitter::new();
    let received = Arc::new(Mutex::new(vec![]));
    let r = received.clone();

    emitter.on("user:login", move |payload| {
        r.lock().unwrap().push(payload.clone());
    });

    emitter.emit("user:login", &json!({"user": "alice"}));
    emitter.emit("user:login", &json!({"user": "bob"}));

    let msgs = received.lock().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["user"], "alice");
    assert_eq!(msgs[1]["user"], "bob");
}

// ---------------------------------------------------------------------------
// Multi-module Grid: nested module with ForEach renders items from scoped state
// ---------------------------------------------------------------------------

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AppState {
    current_view: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SearchState {
    search_query: String,
    explore_posts: Vec<ExplorePost>,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExplorePost {
    id: String,
    image_url: String,
}

#[test]
fn test_nested_module_grid_renders_items() {
    use hypen_server::remote::{ModuleSessionConfig, RemoteSession};
    use hypen_server::discovery::ComponentRegistry;

    // Same pattern as examples/social/rust: App + Search modules,
    // Search has a Grid(@state.explorePosts) that should render Image elements.

    let app_module = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState {
                current_view: "search".to_string(),
            })
            .ui(r#"module App {
                Column {
                    If(condition: "@{state.currentView == 'search'}") {
                        Search()
                    }
                }
            }"#)
            .on_action::<()>("navigateToFeed", |state, _, _| {
                state.current_view = "feed".to_string();
            })
            .build(),
    );

    let search_module = Arc::new(
        HypenApp::module::<SearchState>("Search")
            .state(SearchState {
                search_query: String::new(),
                explore_posts: vec![
                    ExplorePost { id: "p1".into(), image_url: "https://img1.jpg".into() },
                    ExplorePost { id: "p2".into(), image_url: "https://img2.jpg".into() },
                    ExplorePost { id: "p3".into(), image_url: "https://img3.jpg".into() },
                ],
            })
            .build(),
    );

    // Register Search component source (same as the module's DSL)
    let mut components = ComponentRegistry::new();
    components.register("Search", r#"module Search {
        Column {
            Input(placeholder: "Search")
            Grid(@state.explorePosts, key: "id") {
                Image(src: "@{item.imageUrl}")
            }
        }
    }"#, None);

    // Create session — same API as the real server
    let session = RemoteSession::from_definition_with_state(
        app_module,
        components,
        AppState { current_view: "search".to_string() },
        vec![ModuleSessionConfig::from_definition(search_module)],
    );

    // Send hello — this triggers initial render and returns patches
    let responses = session.handle_hello(None);

    // Parse the initial tree response
    let initial_tree: serde_json::Value = responses
        .iter()
        .find_map(|r| {
            let v: serde_json::Value = serde_json::from_str(r).ok()?;
            if v["type"] == "initialTree" { Some(v) } else { None }
        })
        .expect("Should receive an initialTree response");

    let patches = initial_tree["patches"].as_array().expect("patches should be an array");
    let creates: Vec<&str> = patches
        .iter()
        .filter(|p| p["type"] == "create")
        .filter_map(|p| p["elementType"].as_str())
        .collect();

    // Grid container must be present
    assert!(
        creates.contains(&"Grid"),
        "Initial render should create a Grid element. Got: {:?}",
        creates
    );

    // 3 Image elements for the 3 explore posts
    let image_count = creates.iter().filter(|&&t| t == "Image").count();
    assert_eq!(
        image_count, 3,
        "Should create 3 Image elements. Got creates: {:?}",
        creates
    );

}

// ---------------------------------------------------------------------------
// RemoteSession: nested-module action dispatch actually runs the handler
// ---------------------------------------------------------------------------

/// Regression test for the RemoteSession action stubs: before the fix,
/// `handle_action` relied on engine-level no-op handlers and a fragile
/// pre-compute ritual, and nested-module handlers were keyed by
/// case-sensitive module names while the engine's scope map uses
/// lowercased keys. This test dispatches an action declared on a nested
/// module through the session's wire protocol and asserts that the
/// handler ran (module state advanced) and that patches were emitted.
#[test]
fn test_remote_session_dispatches_nested_module_action() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::{ModuleSessionConfig, RemoteSession};

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ShellState {}

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct CounterModState {
        count: i32,
    }

    let shell = Arc::new(
        HypenApp::module::<ShellState>("Shell")
            .state(ShellState {})
            .ui(r#"module Shell {
                Column {
                    Counter()
                }
            }"#)
            .build(),
    );

    let counter = Arc::new(
        HypenApp::module::<CounterModState>("Counter")
            .state(CounterModState { count: 0 })
            .on_action::<()>("bump", |state, _, _| {
                state.count += 1;
            })
            .build(),
    );

    let mut components = ComponentRegistry::new();
    components.register(
        "Counter",
        r#"module Counter {
            Text("Count: @{state.count}")
        }"#,
        None,
    );

    let session = RemoteSession::from_definition_with_state(
        shell,
        components,
        ShellState {},
        vec![ModuleSessionConfig::from_definition(counter)],
    );

    // Initial render.
    let _ = session.handle_hello(None);

    // Dispatch the nested-module action through the wire protocol. Note
    // that the `module` field uses the original-case module name ("Counter"),
    // as clients would send it.
    let action_json = r#"{"type":"dispatchAction","module":"Counter","action":"bump"}"#;
    let responses = session.handle_message(action_json);

    // Revision must have advanced, proving the dispatch was routed and
    // the handler ran (otherwise `handle_action` would early-return
    // without bumping the revision).
    assert_eq!(
        session.revision(),
        1,
        "revision should advance after a successful nested-module dispatch"
    );

    // The session should have emitted a patch message. With a Text node
    // bound to `@{state.count}`, bumping the counter must produce at
    // least one SetText/SetProp patch.
    let has_patch_msg = responses.iter().any(|r| r.contains("\"type\":\"patch\""));
    assert!(
        has_patch_msg,
        "expected a patch message from nested-module dispatch, got: {:?}",
        responses
    );

    // Dispatch two more times for good measure — the handler must be
    // called each time, so the module state (and revision) keeps
    // advancing monotonically.
    for _ in 0..2 {
        let _ = session.handle_message(action_json);
    }
    assert_eq!(session.revision(), 3, "revision should advance per dispatch");
}

/// RemoteSession installs `router.*` engine action handlers on construction
/// so `@router.push(to: "/x")` in the DSL drives the session's router —
/// cross-SDK parity with TS / Go / Swift / Kotlin. This also mirrors the
/// new path into the primary module's `location` state field when present.
#[test]
fn test_remote_session_router_push_updates_location() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::RemoteSession;

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct AppState {
        location: String,
    }

    let app = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState { location: "/".into() })
            .ui(r#"module App {
                Column {
                    Text("Path: @{state.location}")
                }
            }"#)
            .build(),
    );

    let session = RemoteSession::from_definition(app, ComponentRegistry::new());
    let _ = session.handle_hello(None);
    assert_eq!(session.router().current_path(), "/");

    // Simulate a DSL-level `@router.push(to: "/search")` dispatch. The
    // engine action handler installed by RemoteSession::new runs the
    // push synchronously and mirrors the path into `state.location`.
    let push = r#"{"type":"dispatchAction","module":"App","action":"router.push","payload":{"to":"/search"}}"#;
    let _ = session.handle_message(push);

    assert_eq!(session.router().current_path(), "/search");
    let state_json = session.get_state();
    assert_eq!(
        state_json.get("location").and_then(|v| v.as_str()),
        Some("/search"),
        "primary state.location should mirror the router path, got {state_json}"
    );
}

/// `@router.replace` swaps the current path in place (no history entry)
/// and mirrors into `state.location`. Paired with the push / back tests
/// to cover the full reserved namespace.
#[test]
fn test_remote_session_router_replace_updates_path() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::RemoteSession;

    #[derive(Clone, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AppState { location: String }

    let app = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState { location: "/".into() })
            .ui(r#"module App { Text("@{state.location}") }"#)
            .build(),
    );
    let session = RemoteSession::from_definition(app, ComponentRegistry::new());
    let _ = session.handle_hello(None);

    let dispatch = |kind: &str, to: &str| {
        format!(r#"{{"type":"dispatchAction","module":"App","action":"router.{kind}","payload":{{"to":"{to}"}}}}"#)
    };
    let _ = session.handle_message(&dispatch("push", "/a"));
    let _ = session.handle_message(&dispatch("replace", "/b"));

    assert_eq!(session.router().current_path(), "/b");
    assert_eq!(
        session.get_state().get("location").and_then(|v| v.as_str()),
        Some("/b"),
    );
    // History depth check: `router.back` should pop /b off and leave / —
    // proving replace didn't push a history frame.
    let _ = session.handle_message(r#"{"type":"dispatchAction","module":"App","action":"router.back"}"#);
    assert_eq!(session.router().current_path(), "/");
}

/// The `@router.*` namespace is installed unconditionally at session
/// construction — even when the primary module declared zero actions.
/// This regression-guards against a refactor that accidentally gates
/// the router handler installation on `config.action_names` being
/// non-empty (the loop that registers user actions is right next to
/// the router-handler install site).
#[test]
fn test_remote_session_router_works_with_no_user_actions() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::RemoteSession;

    #[derive(Clone, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AppState { location: String }

    let app = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState { location: "/".into() })
            .ui(r#"module App { Text("@{state.location}") }"#)
            // no .on_action(...) calls — action_names is empty.
            .build(),
    );
    let session = RemoteSession::from_definition(app, ComponentRegistry::new());
    let _ = session.handle_hello(None);

    let push = r#"{"type":"dispatchAction","module":"App","action":"router.push","payload":{"to":"/x"}}"#;
    let _ = session.handle_message(push);
    assert_eq!(session.router().current_path(), "/x");
}

/// When the primary state has no `location` field the router still
/// functions — the mirror is a best-effort write, not a precondition.
/// Without this guard, a primary state shape that happens not to carry
/// `location` would have the router push succeed but silently strip
/// other fields (or blow up deserialization).
#[test]
fn test_remote_session_router_push_without_location_field() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::RemoteSession;

    #[derive(Clone, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlainState { label: String }

    let app = Arc::new(
        HypenApp::module::<PlainState>("App")
            .state(PlainState { label: "hi".into() })
            .ui(r#"module App { Text("@{state.label}") }"#)
            .build(),
    );
    let session = RemoteSession::from_definition(app, ComponentRegistry::new());
    let _ = session.handle_hello(None);

    let push = r#"{"type":"dispatchAction","module":"App","action":"router.push","payload":{"to":"/z"}}"#;
    let _ = session.handle_message(push);

    // Router moved but state is untouched (no `location` field to mirror into).
    assert_eq!(session.router().current_path(), "/z");
    assert_eq!(session.get_state().get("label").and_then(|v| v.as_str()), Some("hi"));
    assert!(session.get_state().get("location").is_none());
}

/// `on_route_enter` fires with extracted params whenever nav lands on
/// the pattern, and its mutations to nested-module state slots reach
/// the engine (producing patches in the same WS frame).
#[test]
fn test_remote_session_route_enter_hook() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::{ModuleSessionConfig, RemoteSession};

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct AppState {
        location: String,
    }
    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct CommentsState {
        post_id: String,
        body: String,
    }

    let app = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState { location: "/".into() })
            .ui(r#"module App { Comments() }"#)
            .build(),
    );
    let comments = Arc::new(
        HypenApp::module::<CommentsState>("Comments")
            .state(CommentsState::default())
            .build(),
    );

    let mut components = ComponentRegistry::new();
    components.register(
        "Comments",
        r#"module Comments { Text("@{state.postId}: @{state.body}") }"#,
        None,
    );

    let session = RemoteSession::from_definition_with_state(
        app,
        components,
        AppState { location: "/".into() },
        vec![ModuleSessionConfig::from_definition(comments)],
    );

    session.on_route_enter("/comments/:postId", |params, state, _ctx| {
        let post_id = params.get("postId").cloned().unwrap_or_default();
        if let Some(slot) = state.get_mut("comments") {
            if let Some(obj) = slot.as_object_mut() {
                obj.insert("postId".into(), serde_json::Value::String(post_id.clone()));
                obj.insert(
                    "body".into(),
                    serde_json::Value::String(format!("loaded {post_id}")),
                );
            }
        }
    });

    let _ = session.handle_hello(None);
    let push = r#"{"type":"dispatchAction","module":"App","action":"router.push","payload":{"to":"/comments/p42"}}"#;
    let responses = session.handle_message(push);

    // Patches must be present — the route hook mutated the Comments
    // slot and `handle_action` should have flushed that into the engine.
    assert!(
        responses.iter().any(|r| r.contains("\"type\":\"patch\"")),
        "expected patch response after route enter hook, got: {responses:?}"
    );

    let state_json = session.get_state();
    assert_eq!(
        state_json.get("location").and_then(|v| v.as_str()),
        Some("/comments/p42"),
    );
}

/// `router.back` pops history and also mirrors the path. Paired sanity
/// check with `test_remote_session_router_push_updates_location`.
#[test]
fn test_remote_session_router_back_restores_previous() {
    use hypen_server::discovery::ComponentRegistry;
    use hypen_server::remote::RemoteSession;

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct AppState {
        location: String,
    }

    let app = Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState { location: "/".into() })
            .ui(r#"module App { Text("@{state.location}") }"#)
            .build(),
    );
    let session = RemoteSession::from_definition(app, ComponentRegistry::new());
    let _ = session.handle_hello(None);

    let push = |to: &str| {
        format!(
            r#"{{"type":"dispatchAction","module":"App","action":"router.push","payload":{{"to":"{to}"}}}}"#
        )
    };
    let _ = session.handle_message(&push("/a"));
    let _ = session.handle_message(&push("/b"));
    assert_eq!(session.router().current_path(), "/b");

    let back = r#"{"type":"dispatchAction","module":"App","action":"router.back"}"#;
    let _ = session.handle_message(back);
    assert_eq!(session.router().current_path(), "/a");
    assert_eq!(
        session.get_state().get("location").and_then(|v| v.as_str()),
        Some("/a"),
    );
}
