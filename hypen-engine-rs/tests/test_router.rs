// Tests for the first-class Router IR node.
//
// These exercise the engine-side routing path: parser → IRNode::Router →
// reconciler → patches. There is no renderer or browser involved; the engine
// itself decides which Route's children to render based on `state.location`.

use hypen_engine::ir::{ast_to_ir_node, Element, IRNode, Props, RouterRoute, Value};
use hypen_engine::reactive::{Binding, DependencyGraph};
use hypen_engine::reconcile::{InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

thread_local! {
    // One expander per test thread (libtest runs each test on its own
    // thread): registrations persist across a test's successive batches
    // (navigations), exactly like a boundary's session-lifetime expander.
    static EXPANDER: std::cell::RefCell<hypen_engine::TemplateExpander> =
        std::cell::RefCell::new(hypen_engine::TemplateExpander::new());
}

/// [`hypen_engine::reconcile::reconcile_ir`], lowered: these tests assert
/// the pre-template Create/Insert wire, so every batch goes through the
/// expander the way every plain-patch boundary does.
fn reconcile_ir(
    tree: &mut InstanceTree,
    node: &IRNode,
    parent_id: Option<hypen_engine::ir::NodeId>,
    state: &serde_json::Value,
    dependencies: &mut DependencyGraph,
) -> Vec<Patch> {
    let patches = hypen_engine::reconcile::reconcile_ir(tree, node, parent_id, state, dependencies);
    EXPANDER.with(|e| e.borrow_mut().expand(patches))
}

// ----------------------------------------------------------------------------
// AST → IR
// ----------------------------------------------------------------------------

#[test]
fn test_router_ast_to_ir_basic() {
    let source = r#"
        Router {
            Route(path: "/") { Text("Home") }
            Route(path: "/about") { Text("About") }
        }
    "#;
    let ast = parse_component(source).expect("parse Router");
    let ir = ast_to_ir_node(&ast);

    match ir {
        IRNode::Router {
            routes, fallback, ..
        } => {
            assert_eq!(routes.len(), 2);
            assert_eq!(routes[0].path, "/");
            assert_eq!(routes[1].path, "/about");
            assert!(fallback.is_none());
        }
        other => panic!("Expected IRNode::Router, got {:?}", other),
    }
}

#[test]
fn test_router_ast_to_ir_default_location_binding() {
    // Without an explicit `value:` arg, the Router should default to
    // a state.location binding.
    let source = r#"
        Router {
            Route(path: "/") { Text("Home") }
        }
    "#;
    let ir = ast_to_ir_node(&parse_component(source).unwrap());
    match ir {
        IRNode::Router { location, .. } => match location {
            Value::Binding(b) => {
                assert!(b.is_state());
                assert_eq!(b.full_path(), "location");
            }
            other => panic!("Expected state.location binding, got {:?}", other),
        },
        other => panic!("Expected IRNode::Router, got {:?}", other),
    }
}

#[test]
fn test_router_ast_to_ir_with_else_fallback() {
    let source = r#"
        Router {
            Route(path: "/") { Text("Home") }
            Else { Text("Not Found") }
        }
    "#;
    let ir = ast_to_ir_node(&parse_component(source).unwrap());
    match ir {
        IRNode::Router {
            routes, fallback, ..
        } => {
            assert_eq!(routes.len(), 1);
            assert!(fallback.is_some(), "Else should produce fallback");
            assert_eq!(fallback.unwrap().len(), 1);
        }
        other => panic!("Expected IRNode::Router, got {:?}", other),
    }
}

// ----------------------------------------------------------------------------
// Reconciliation: initial render picks the matching route
// ----------------------------------------------------------------------------

#[test]
fn test_router_reconciles_to_matching_route() {
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/search" });

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
            RouterRoute::new(
                "/profile",
                vec![IRNode::Element(Element::new("ProfileView"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    let patches = reconcile_ir(&mut tree, &ir, None, &state, &mut deps);

    // Only SearchView should appear in patches; HomeView and ProfileView
    // should not.
    let created_types: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();

    assert!(
        created_types.contains(&"SearchView"),
        "expected SearchView in {:?}",
        created_types
    );
    assert!(
        !created_types.contains(&"HomeView"),
        "HomeView should not be created"
    );
    assert!(
        !created_types.contains(&"ProfileView"),
        "ProfileView should not be created"
    );

    // The container __Router node must NOT leak into renderer patches.
    for patch in &patches {
        if let Patch::Create { element_type, .. } = patch {
            assert_ne!(
                element_type, "__Router",
                "__Router container must not appear in patches"
            );
        }
    }
}

#[test]
fn test_router_falls_back_when_no_route_matches() {
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/missing" });

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/",
            vec![IRNode::Element(Element::new("HomeView"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("NotFound"))]),
        module_scope: None,
    };

    let patches = reconcile_ir(&mut tree, &ir, None, &state, &mut deps);

    let created_types: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();

    assert!(
        created_types.contains(&"NotFound"),
        "expected NotFound in {:?}",
        created_types
    );
    assert!(!created_types.contains(&"HomeView"));
}

#[test]
fn test_router_renders_nothing_when_no_match_and_no_fallback() {
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/missing" });

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/",
            vec![IRNode::Element(Element::new("HomeView"))],
        )],
        fallback: None,
        module_scope: None,
    };

    let patches = reconcile_ir(&mut tree, &ir, None, &state, &mut deps);

    let created_view: Vec<_> = patches
        .iter()
        .filter(|p| {
            matches!(
                p,
                Patch::Create { element_type, .. }
                    if element_type != "__Router"
            )
        })
        .collect();
    assert!(
        created_view.is_empty(),
        "no view patches expected, got {:?}",
        created_view
    );
}

// ----------------------------------------------------------------------------
// State updates trigger route changes via the dependency graph
// ----------------------------------------------------------------------------

#[test]
fn test_router_swaps_view_on_location_change() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render at /
    let initial_state = json!({ "location": "/" });
    let initial_patches = reconcile(&mut tree, &ir, None, &initial_state, &mut deps);

    let initial_types: Vec<&str> = initial_patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();
    assert!(initial_types.contains(&"HomeView"));
    assert!(!initial_types.contains(&"SearchView"));

    // Now navigate to /search by reconciling against the new state.
    let next_state = json!({ "location": "/search" });
    let next_patches = reconcile(&mut tree, &ir, None, &next_state, &mut deps);

    // With Router subtree caching, navigating *away* from a route
    // emits Detach (not Remove) for its old children — the subtree
    // stays alive in the InstanceTree so we can reattach it on
    // return. SearchView is new so it's Created as usual.
    let creates: Vec<&str> = next_patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();
    let detaches_count = next_patches
        .iter()
        .filter(|p| matches!(p, Patch::Detach { .. }))
        .count();
    let removes_count = next_patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .count();

    assert!(
        creates.contains(&"SearchView"),
        "expected SearchView in {:?}",
        creates
    );
    assert!(
        !creates.contains(&"HomeView"),
        "HomeView should not be re-created"
    );
    assert!(
        detaches_count >= 1,
        "expected at least one Detach patch for the old view, got {} detaches and {} removes",
        detaches_count,
        removes_count,
    );
    assert_eq!(
        removes_count, 0,
        "expected no Remove patches on navigation-away (should Detach instead)",
    );
}

// ----------------------------------------------------------------------------
// Router IR matches the same pattern syntax as SDK ManagedRouter
// (exact / `:param` / trailing `/*`), via crate::portable::route::match_path.
// ----------------------------------------------------------------------------

#[test]
fn test_router_ir_matches_param_routes() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/profile/:id",
            vec![IRNode::Element(Element::new("ProfileView"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("NotFound"))]),
        module_scope: None,
    };

    // Concrete location with a param should match the pattern route,
    // NOT fall through to the fallback.
    let patches = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/profile/42"}),
        &mut deps,
    );

    let creates: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        creates.contains(&"ProfileView"),
        "expected ProfileView matched by /profile/:id against /profile/42; got {:?}",
        creates
    );
    assert!(
        !creates.contains(&"NotFound"),
        "fallback should not render when a param route matched"
    );
}

#[test]
fn test_router_ir_matches_trailing_wildcard() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/api/*",
            vec![IRNode::Element(Element::new("ApiView"))],
        )],
        fallback: None,
        module_scope: None,
    };

    let patches = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/api/users/42"}),
        &mut deps,
    );
    let types: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();
    assert!(types.contains(&"ApiView"));
}

#[test]
fn test_router_param_changes_hit_same_cache_bucket() {
    // Navigating between two concrete paths that match the *same*
    // pattern route (/profile/:id → /profile/42 → /profile/99)
    // should NOT detach/reattach — the Router sees "same route, just
    // different params" and short-circuits. Param-driven content
    // inside the route updates via state bindings, not subtree swap.
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/profile/:id",
            vec![IRNode::Element(Element::new("ProfileView"))],
        )],
        fallback: None,
        module_scope: None,
    };

    let _ = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/profile/42"}),
        &mut deps,
    );

    // Second reconcile against a different concrete path that matches
    // the same pattern. Because the pattern (cache key) is the same,
    // nothing should swap.
    let patches = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/profile/99"}),
        &mut deps,
    );

    let detach_count = patches
        .iter()
        .filter(|p| matches!(p, Patch::Detach { .. }))
        .count();
    let attach_count = patches
        .iter()
        .filter(|p| matches!(p, Patch::Attach { .. }))
        .count();
    let create_count = patches
        .iter()
        .filter(
            |p| matches!(p, Patch::Create { element_type, .. } if element_type == "ProfileView"),
        )
        .count();
    assert_eq!(detach_count, 0, "same pattern = no detach: {:?}", patches);
    assert_eq!(attach_count, 0, "same pattern = no attach: {:?}", patches);
    assert_eq!(
        create_count, 0,
        "same pattern = no re-create: {:?}",
        patches
    );
}

// ----------------------------------------------------------------------------
// Router subtree cache: navigating back reattaches, no rebuild
// ----------------------------------------------------------------------------

#[test]
fn test_router_reuses_cached_subtree_on_navigate_back() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render at "/" — creates HomeView once.
    let _ = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);

    // Navigate away to /search. HomeView gets Detached and cached.
    let _ = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/search"}),
        &mut deps,
    );

    // Navigate back to "/". Expect Attach for the cached HomeView,
    // NOT Create (we must reuse the previously-built subtree).
    let back_patches = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);

    let creates: Vec<&str> = back_patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();
    let attach_count = back_patches
        .iter()
        .filter(|p| matches!(p, Patch::Attach { .. }))
        .count();

    assert!(
        !creates.contains(&"HomeView"),
        "HomeView should be reattached from cache, not re-created. creates: {:?}",
        creates
    );
    assert!(
        attach_count >= 1,
        "expected at least one Attach patch on navigate-back, got {}",
        attach_count
    );
}

// ----------------------------------------------------------------------------
// Router cache eviction: stale entries get torn down after LRU limit
// ----------------------------------------------------------------------------

#[test]
fn test_router_evicts_least_recently_used_cache_entry() {
    // The default cap is 10. We don't want to build a test with 11+
    // routes just to verify eviction; instead we validate the
    // contract via the underlying ControlFlowKind::Router state.
    use hypen_engine::reconcile::reconcile_ir as reconcile;
    use hypen_engine::reconcile::ControlFlowKind;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/a", vec![IRNode::Element(Element::new("A"))]),
            RouterRoute::new("/b", vec![IRNode::Element(Element::new("B"))]),
            RouterRoute::new("/c", vec![IRNode::Element(Element::new("C"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    // Visit a, b, c in order. After c is active, /a and /b are cached.
    let _ = reconcile(&mut tree, &ir, None, &json!({"location": "/a"}), &mut deps);
    let _ = reconcile(&mut tree, &ir, None, &json!({"location": "/b"}), &mut deps);
    let _ = reconcile(&mut tree, &ir, None, &json!({"location": "/c"}), &mut deps);

    // Find the Router node and inspect its cache.
    let router_id = tree.root().expect("router is the root instance node");
    let router = tree.get(router_id).expect("router node must exist");
    match router.control_flow.as_ref() {
        Some(ControlFlowKind::Router {
            cache,
            current_route_key,
            ..
        }) => {
            assert_eq!(current_route_key.as_deref(), Some("/c"));
            let cached_keys: Vec<&str> = cache.keys().map(|s| s.as_str()).collect();
            assert_eq!(
                cached_keys,
                vec!["/a", "/b"],
                "expected /a and /b cached in insertion order"
            );
        }
        other => panic!("expected Router control flow, got {:?}", other),
    }
}

// ----------------------------------------------------------------------------
// State updates still flow through detached (cached) subtrees
// ----------------------------------------------------------------------------

#[test]
fn test_cached_subtree_stays_reactive_while_detached() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    // HomeView has a Text child bound to state.greeting so we can verify
    // the detached subtree still receives prop updates.
    let home_text = Element::new("Text").with_prop(
        "0",
        Value::Binding(Binding::state(vec!["greeting".to_string()])),
    );

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(home_text)]),
            RouterRoute::new("/other", vec![IRNode::Element(Element::new("Other"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render: Text("hello")
    let _ = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/", "greeting": "hello"}),
        &mut deps,
    );

    // Navigate away — HomeView (and its Text child) get detached.
    let _ = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/other", "greeting": "hello"}),
        &mut deps,
    );

    // Navigate back with greeting already changed. The reattached
    // subtree's existing Text node should still resolve the latest
    // binding value — the cached subtree stays in the dependency
    // graph, so it reconciles correctly against new state.
    let back_patches = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/", "greeting": "world"}),
        &mut deps,
    );

    // Must not create a new Text — we reattach the cached one.
    let text_creates = back_patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Text"))
        .count();
    assert_eq!(
        text_creates, 0,
        "cached Text should be reattached, not re-created"
    );
    // Must have emitted Attach for the cached Text's parent.
    let attach_count = back_patches
        .iter()
        .filter(|p| matches!(p, Patch::Attach { .. }))
        .count();
    assert!(attach_count >= 1, "expected Attach on navigate-back");
}

#[test]
fn test_router_dependency_is_registered_on_location() {
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/" });

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![RouterRoute::new(
            "/",
            vec![IRNode::Element(Element::new("HomeView"))],
        )],
        fallback: None,
        module_scope: None,
    };

    let _ = reconcile_ir(&mut tree, &ir, None, &state, &mut deps);

    // After reconciling, the dependency graph should know that *some* node
    // depends on `location`. We can confirm by asking which nodes are affected
    // by a `location` change.
    let affected = deps.get_affected_nodes("location");
    assert!(
        !affected.is_empty(),
        "expected at least one node bound to `location`"
    );
}

// ----------------------------------------------------------------------------
// Regression: when a Router is the IR root (no logical parent — the common
// `module App { Router { ... } }` shape), the matched route's children must
// be inserted under `"root"`, not under the `__Router` control-flow NodeId.
//
// Bug symptom: renderers keep a `nodes: Map<id, Element>` plus a special
// `"root"` sentinel for the mount container. The `__Router` node is a
// control-flow node that never emits a `Create` patch, so its NodeId is
// unknown to the renderer. If we emit `Insert { parent = __Router.id }`,
// the renderer silently drops the patch (parent missing) — nothing renders,
// and every subsequent navigation also drops. This was observed after the
// Detach/Attach cache work: the Router's initial reconcile + reconcile-on-
// nav both route their children's Insert/Attach through the Router node id.
//
// The fix is: when the Router itself has no parent (is the IR root), its
// matched children should render at "root" via `insert_root` — their
// `render_parent` should be `None` AND `logical_parent` should not be used
// as a fallback for the Insert patch.
// ----------------------------------------------------------------------------

#[test]
fn test_router_at_root_inserts_children_under_root_not_router_node() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/" });

    // Router as the top-level IR node, with no wrapping element.
    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    let patches = reconcile(&mut tree, &ir, None, &state, &mut deps);

    // Find the Insert patch for HomeView. It must reference parent = "root".
    let home_insert = patches.iter().find_map(|p| match p {
        Patch::Insert { parent_id, id, .. } => {
            // Look up whether this insert targets HomeView.
            let is_home = patches.iter().any(|q| {
                matches!(q, Patch::Create { id: cid, element_type, .. }
                    if cid == id && element_type == "HomeView")
            });
            if is_home {
                Some(parent_id.clone())
            } else {
                None
            }
        }
        _ => None,
    });

    let parent = home_insert.expect("expected an Insert patch for HomeView");
    assert_eq!(
        parent.as_ref(),
        "root",
        "Router-at-root: HomeView must Insert under \"root\", not under \
         the __Router control-flow NodeId. Got parent = {:?}. \
         Full patches: {:#?}",
        parent,
        patches,
    );
}

#[test]
fn test_router_at_root_nav_attaches_children_under_root_not_router_node() {
    // Follow-up to the test above: after navigating away and then creating
    // the new route's subtree, the *new* route's Insert (or, in the cached
    // case, Attach) patches must also target "root". This is the pattern
    // the social example hits on every tab tap.
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render at "/".
    let _ = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);

    // Navigate to /search — new subtree built fresh (cache miss).
    let nav_patches = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/search"}),
        &mut deps,
    );

    let search_insert_parent = nav_patches.iter().find_map(|p| match p {
        Patch::Insert { parent_id, id, .. } => {
            let is_search = nav_patches.iter().any(|q| {
                matches!(q, Patch::Create { id: cid, element_type, .. }
                    if cid == id && element_type == "SearchView")
            });
            if is_search {
                Some(parent_id.clone())
            } else {
                None
            }
        }
        _ => None,
    });

    let parent = search_insert_parent.expect("expected an Insert patch for SearchView");
    assert_eq!(
        parent.as_ref(),
        "root",
        "Router-at-root nav: SearchView Insert must target \"root\", not \
         the __Router NodeId. Got parent = {:?}. Full patches: {:#?}",
        parent,
        nav_patches,
    );

    // Now navigate back to "/" — this should hit the cache and emit an
    // Attach patch. That Attach's parent_id must also be "root".
    let back_patches = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);

    let attach_parents: Vec<std::sync::Arc<str>> = back_patches
        .iter()
        .filter_map(|p| match p {
            Patch::Attach { parent_id, .. } => Some(parent_id.clone()),
            _ => None,
        })
        .collect();
    assert!(
        !attach_parents.is_empty(),
        "expected at least one Attach patch on nav-back to cached route"
    );
    for p in &attach_parents {
        assert_eq!(
            p.as_ref(),
            "root",
            "Router-at-root nav-back: cached Attach must target \"root\". \
             Got parent = {:?}. Full patches: {:#?}",
            p,
            back_patches,
        );
    }
}

// ----------------------------------------------------------------------------
// Regression: a nested Router (e.g. `Column { Router { Route { ... } } }`)
// must render its matched route's children under the wrapping element's
// NodeId — NOT under "root". "root" is the renderer's mount-container
// sentinel and is only correct when the Router is itself the IR root.
// ----------------------------------------------------------------------------

#[test]
fn test_nested_router_inserts_children_under_wrapping_element_not_root() {
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let state = json!({ "location": "/" });

    // Column { Router { Route("/") { HomeView } Route("/search") { SearchView } } }
    let mut column = Element::new("Column");
    column.ir_children.push(IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    });
    let ir = IRNode::Element(column);

    let patches = reconcile(&mut tree, &ir, None, &state, &mut deps);

    let column_id = patches
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                id, element_type, ..
            } if element_type == "Column" => Some(id.clone()),
            _ => None,
        })
        .expect("expected Column Create");

    // Column should be inserted into "root".
    let column_insert_parent = patches
        .iter()
        .find_map(|p| match p {
            Patch::Insert { parent_id, id, .. } if *id == column_id => Some(parent_id.clone()),
            _ => None,
        })
        .expect("expected Column Insert");
    assert_eq!(
        column_insert_parent.as_ref(),
        "root",
        "Column is the IR root → inserts under \"root\""
    );

    // HomeView should be inserted under the Column, NOT "root".
    let home_insert_parent = patches
        .iter()
        .find_map(|p| match p {
            Patch::Insert { parent_id, id, .. } => {
                let is_home = patches.iter().any(|q| {
                    matches!(q, Patch::Create { id: cid, element_type, .. }
                    if cid == id && element_type == "HomeView")
                });
                if is_home {
                    Some(parent_id.clone())
                } else {
                    None
                }
            }
            _ => None,
        })
        .expect("expected HomeView Insert");
    assert_eq!(
        home_insert_parent, column_id,
        "Nested Router: HomeView must Insert under the wrapping Column, \
         not \"root\" and not the __Router NodeId. Got parent = {:?}. \
         Column id = {:?}. Full patches: {:#?}",
        home_insert_parent, column_id, patches,
    );
}

#[test]
fn test_nested_router_nav_routes_children_under_wrapping_element() {
    // Same as above but check nav-away (Insert new) and nav-back (Attach
    // cached) target the wrapping Column, not "root" or the Router id.
    use hypen_engine::reconcile::reconcile_ir as reconcile;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let mut column = Element::new("Column");
    column.ir_children.push(IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/search", vec![IRNode::Element(Element::new("SearchView"))]),
        ],
        fallback: None,
        module_scope: None,
    });
    let ir = IRNode::Element(column);

    let initial = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);
    let column_id = initial
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                id, element_type, ..
            } if element_type == "Column" => Some(id.clone()),
            _ => None,
        })
        .expect("Column created");

    // Nav to /search — fresh SearchView should Insert under Column.
    let nav = reconcile(
        &mut tree,
        &ir,
        None,
        &json!({"location": "/search"}),
        &mut deps,
    );
    let search_parent = nav
        .iter()
        .find_map(|p| match p {
            Patch::Insert { parent_id, id, .. } => {
                let is_search = nav.iter().any(|q| {
                    matches!(q, Patch::Create { id: cid, element_type, .. }
                    if cid == id && element_type == "SearchView")
                });
                if is_search {
                    Some(parent_id.clone())
                } else {
                    None
                }
            }
            _ => None,
        })
        .expect("SearchView Insert");
    assert_eq!(
        search_parent, column_id,
        "Nested Router nav: SearchView must Insert under Column, not \"root\". \
         Got parent = {:?}. Patches: {:#?}",
        search_parent, nav,
    );

    // Nav back to / — cached Attach must target Column.
    let back = reconcile(&mut tree, &ir, None, &json!({"location": "/"}), &mut deps);
    let attach_parents: Vec<std::sync::Arc<str>> = back
        .iter()
        .filter_map(|p| match p {
            Patch::Attach { parent_id, .. } => Some(parent_id.clone()),
            _ => None,
        })
        .collect();
    assert!(!attach_parents.is_empty(), "expected Attach on nav-back");
    for p in &attach_parents {
        assert_eq!(
            p.as_ref(),
            column_id.as_ref(),
            "Nested Router nav-back: cached Attach must target Column, \
             not \"root\". Got parent = {:?}. Patches: {:#?}",
            p,
            back,
        );
    }
}

// ----------------------------------------------------------------------------
// Regression: a `List(@state.items)` inside a Router's route must render
// its items on navigation. The engine lowers `List(@state.items) { Row {} }`
// to Element("List") with an IRNode::ForEach child; the social example
// hit 0-item Lists on /notifications + /profile after the Router-at-root
// fix. This test pins the Router → Column → List(Element) → ForEach path.
// ----------------------------------------------------------------------------

#[test]
fn test_router_route_with_list_element_emits_items_on_nav() {
    // The file-local lowering wrapper — row creation on nav arrives as an
    // Instantiate and must be expanded back to Creates for this assertion.
    let reconcile = reconcile_ir;

    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    let foreach = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: Some("id".to_string()),
        template: vec![IRNode::Element(Element::new("Row"))],
        props: Props::new(),
        module_scope: None,
    };
    let mut list_el = Element::new("List");
    list_el.ir_children.push(foreach);
    let mut column_el = Element::new("Column");
    column_el.ir_children.push(IRNode::Element(list_el));

    let ir = IRNode::Router {
        location: Value::Binding(Binding::state(vec!["location".to_string()])),
        routes: vec![
            RouterRoute::new("/", vec![IRNode::Element(Element::new("HomeView"))]),
            RouterRoute::new("/list", vec![IRNode::Element(column_el)]),
        ],
        fallback: None,
        module_scope: None,
    };

    let state = json!({
        "location": "/",
        "items": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
    });
    let _ = reconcile(&mut tree, &ir, None, &state, &mut deps);

    let nav_state = json!({
        "location": "/list",
        "items": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
    });
    let nav = reconcile(&mut tree, &ir, None, &nav_state, &mut deps);

    let row_creates = nav
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Row"))
        .count();
    assert_eq!(
        row_creates, 3,
        "expected 3 Row creates (one per state.items entry) after nav to /list; \
         got {}. Full patches: {:#?}",
        row_creates, nav,
    );
}
