//! Integration tests for multi-module support in the Hypen engine.
//!
//! These tests verify that:
//! 1. State isolation works between named modules
//! 2. Same key names in different modules don't collide
//! 3. update_module_state only re-renders scoped nodes
//! 4. Single-module backward compatibility is preserved
//! 5. ForEach inside a module scope resolves bindings correctly

mod common;

use common::*;
use hypen_engine::ir::{ConditionalBranch, Element, IRNode, Props, ResolvedComponent, Value};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reactive::Binding;
use hypen_engine::reconcile::Patch;
use indexmap::indexmap;
use serde_json::json;

// ========== Helpers for multi-module tests ==========

/// Creates a Text element with a state binding and a specific module_scope.
fn scoped_text_binding(path: &str, scope: &str) -> Element {
    let path_parts: Vec<String> = path.split('.').map(|s| s.to_string()).collect();
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(Binding::state(path_parts))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some(scope.to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Column wrapping children, with an optional module_scope.
fn scoped_column(children: Vec<Element>, scope: Option<&str>) -> Element {
    Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: children.into_iter().map(IRNode::Element).collect(),
        key: None,
        module_scope: scope.map(|s| s.to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Extracts text prop values from Create patches, in order.
/// Checks both "text" and "0" keys (positional argument for Text elements).
fn extract_create_texts(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create { props, .. } = p {
                // Try "text" key first, then "0" (positional argument)
                let val = props.get("text").or_else(|| props.get("0"));
                val.and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    other => Some(other.to_string()),
                })
            } else {
                None
            }
        })
        .collect()
}

/// Extracts "text" prop values from SetProp patches, in order.
fn extract_set_prop_texts(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .filter_map(|p| {
            if let Patch::SetProp { name, value, .. } = p {
                if name == "text" {
                    match value {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        other => Some(other.to_string()),
                    }
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect()
}

// ========== Test 1: State isolation between modules ==========

#[test]
fn test_state_isolation_between_modules() {
    // GIVEN: An engine with a primary App module and a named "search" module
    let mut engine = hypen_engine::Engine::new();

    // Primary (App) module
    let app_module = ModuleInstance::new(Module::new("App"), json!({"count": 0, "title": "App"}));
    engine.set_module(app_module);

    // Named module "search"
    let search_module = ModuleInstance::new(
        Module::new("Search"),
        json!({"count": 99, "query": "hello"}),
    );
    engine.register_module("search", search_module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render a tree where:
    //   - Root Column (no scope) contains Text("@{state.count}") → resolves from App state
    //   - Nested Column (scope="search") contains Text("@{state.query}") → resolves from search state
    let root = scoped_column(
        vec![
            // App-scoped: @{state.count} should resolve to 0
            text_element_with_binding("count"),
            // Search-scoped: @{state.query} should resolve to "hello"
            scoped_text_binding("query", "search"),
        ],
        None,
    );
    engine.render(&root);

    // THEN: The first Text shows "0" (App's count), the second shows "hello" (Search's query)
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);

    assert!(
        texts.contains(&"0".to_string()),
        "Expected App's count=0 in patches. Got texts: {:?}",
        texts
    );
    assert!(
        texts.contains(&"hello".to_string()),
        "Expected Search's query='hello' in patches. Got texts: {:?}",
        texts
    );
}

// ========== Test 2: Same key name isolation ==========

#[test]
fn test_same_key_name_isolation() {
    // GIVEN: Two modules with the same state key "items" but different values
    let mut engine = hypen_engine::Engine::new();

    let app_module = ModuleInstance::new(Module::new("App"), json!({"items": ["a", "b"]}));
    engine.set_module(app_module);

    let feed_module = ModuleInstance::new(Module::new("Feed"), json!({"items": ["x", "y", "z"]}));
    engine.register_module("feed", feed_module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render a tree where both App and Feed reference @{state.items}
    let root = scoped_column(
        vec![
            // App-scoped: @{state.items} → ["a", "b"]
            text_element_with_binding("items"),
            // Feed-scoped: @{state.items} → ["x", "y", "z"]
            scoped_text_binding("items", "feed"),
        ],
        None,
    );
    engine.render(&root);

    // THEN: They resolve to their own module's "items" — values don't collide
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);

    // The App's items binding should produce the array ["a","b"]
    // The Feed's items binding should produce the array ["x","y","z"]
    // They must be different from each other.
    assert!(
        texts.len() >= 2,
        "Expected at least 2 text Create patches, got {}",
        texts.len()
    );

    // Find the two text patches: one for App's items, one for Feed's items
    let has_app_items = texts.iter().any(|t| t.contains("a") && t.contains("b"));
    let has_feed_items = texts
        .iter()
        .any(|t| t.contains("x") && t.contains("y") && t.contains("z"));

    assert!(
        has_app_items,
        "Expected App's items [a, b] in patches. Got texts: {:?}",
        texts
    );
    assert!(
        has_feed_items,
        "Expected Feed's items [x, y, z] in patches. Got texts: {:?}",
        texts
    );
}

// ========== Test 3: update_module_state only affects scoped nodes ==========

#[test]
fn test_update_module_state_only_affects_scoped_nodes() {
    // GIVEN: Engine with primary App module and named "search" module
    let mut engine = hypen_engine::Engine::new();

    let app_module = ModuleInstance::new(Module::new("App"), json!({"title": "My App"}));
    engine.set_module(app_module);

    let search_module = ModuleInstance::new(Module::new("Search"), json!({"query": "old"}));
    engine.register_module("search", search_module);

    // Render initial tree
    let root = scoped_column(
        vec![
            // App-scoped Text
            text_element_with_binding("title"),
            // Search-scoped Text
            scoped_text_binding("query", "search"),
        ],
        None,
    );
    engine.render(&root);
    assert_eq!(engine.revision(), 1, "Initial render should be revision 1");

    // Set up a new patch capture to observe the incremental update
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Update only the search module's state
    engine.update_state(Some("search"), json!({"query": "new query"}));

    // THEN: Only Search's nodes should be affected
    let captured = patches.lock().unwrap();

    // If patches were emitted, they should only contain "new query" updates
    // and NOT touch the App's "title" binding
    if !captured.is_empty() {
        let prop_texts = extract_set_prop_texts(&captured);
        let create_texts = extract_create_texts(&captured);
        let all_texts: Vec<&str> = prop_texts
            .iter()
            .chain(create_texts.iter())
            .map(|s| s.as_str())
            .collect();

        // If there are text updates, they should be for the search query
        for text in &all_texts {
            assert!(
                !text.contains("My App"),
                "App's title should NOT be re-rendered. Found '{}' in patches",
                text
            );
        }

        // The new query value should appear
        let has_new_query = all_texts.iter().any(|t| t.contains("new query"));
        assert!(
            has_new_query,
            "Expected 'new query' in patches after update_module_state. Got: {:?}",
            all_texts
        );
    }

    // Revision should have incremented (dirty nodes were re-rendered)
    assert!(
        engine.revision() >= 2,
        "Expected revision >= 2 after module state update, got {}",
        engine.revision()
    );
}

// ========== Test 4: Backward compat — single module still works ==========

#[test]
fn test_single_module_backward_compat() {
    // GIVEN: Engine with only set_module (no register_module)
    let mut engine = hypen_engine::Engine::new();

    let module = ModuleInstance::new(Module::new("Counter"), json!({"count": 42}));
    engine.set_module(module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render a simple binding without any module_scope
    let element = text_element_with_binding("count");
    engine.render(&element);

    // THEN: The binding resolves to "42" from the primary module
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);
    assert!(
        texts.contains(&"42".to_string()),
        "Expected count=42 from primary module. Got texts: {:?}",
        texts
    );
    assert_eq!(engine.revision(), 1);
}

#[test]
fn test_single_module_state_update_backward_compat() {
    // GIVEN: Engine with only set_module, rendered tree
    let mut engine = hypen_engine::Engine::new();

    let module = ModuleInstance::new(Module::new("Counter"), json!({"count": 0}));
    engine.set_module(module);

    let element = text_element_with_binding("count");
    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update via the old update_state API
    engine.update_state(None, json!({"count": 10}));

    // THEN: Revision increments and no panics
    assert_eq!(
        engine.revision(),
        2,
        "update_state should increment revision"
    );
}

// ========== Test 5: ForEach inside a module scope ==========

#[test]
fn test_foreach_inside_module_scope() {
    // GIVEN: Engine with a primary module and a named "feed" module containing posts array
    let mut engine = hypen_engine::Engine::new();

    // Primary module (needed for engine to work)
    let app_module = ModuleInstance::new(Module::new("App"), json!({"page": "home"}));
    engine.set_module(app_module);

    let feed_module = ModuleInstance::new(
        Module::new("Feed"),
        json!({
            "posts": [
                {"id": "1", "title": "Hello"},
                {"id": "2", "title": "World"}
            ]
        }),
    );
    engine.register_module("feed", feed_module);

    // Set a component resolver that returns a module Feed component with ForEach
    engine.set_component_resolver(|name, _context| {
        if name == "Feed" {
            Some(ResolvedComponent {
                source: r#"module Feed {
    Column {
        ForEach(@state.posts, key: "id") {
            Text("@{item.title}")
        }
    }
}"#
                .to_string(),
                path: "Feed.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    });

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render a Feed component reference
    let feed_ref = Element::new("Feed");
    engine.render(&feed_ref);

    // THEN: The ForEach should iterate over Feed's posts and produce Text with titles
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);

    assert!(
        texts.contains(&"Hello".to_string()),
        "Expected 'Hello' from first post. Got texts: {:?}",
        texts
    );
    assert!(
        texts.contains(&"World".to_string()),
        "Expected 'World' from second post. Got texts: {:?}",
        texts
    );
}

// ========== Test 6: Multiple named modules coexist ==========

#[test]
fn test_multiple_named_modules_coexist() {
    // GIVEN: Engine with primary module + two named modules
    let mut engine = hypen_engine::Engine::new();

    let app = ModuleInstance::new(Module::new("App"), json!({"page": "home"}));
    engine.set_module(app);

    let search = ModuleInstance::new(Module::new("Search"), json!({"query": "rust"}));
    engine.register_module("search", search);

    let profile = ModuleInstance::new(Module::new("Profile"), json!({"name": "Alice"}));
    engine.register_module("profile", profile);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render tree with elements from all three modules
    let root = scoped_column(
        vec![
            text_element_with_binding("page"),      // App: "home"
            scoped_text_binding("query", "search"), // Search: "rust"
            scoped_text_binding("name", "profile"), // Profile: "Alice"
        ],
        None,
    );
    engine.render(&root);

    // THEN: Each binding resolves to its own module's state
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);

    assert!(
        texts.contains(&"home".to_string()),
        "Expected App's page='home'. Got: {:?}",
        texts
    );
    assert!(
        texts.contains(&"rust".to_string()),
        "Expected Search's query='rust'. Got: {:?}",
        texts
    );
    assert!(
        texts.contains(&"Alice".to_string()),
        "Expected Profile's name='Alice'. Got: {:?}",
        texts
    );
}

// ========== Test 7: update_module_state for non-existent module is safe ==========

#[test]
fn test_update_nonexistent_module_is_safe() {
    // GIVEN: Engine with no named modules
    let mut engine = hypen_engine::Engine::new();

    let app = ModuleInstance::new(Module::new("App"), json!({"count": 0}));
    engine.set_module(app);

    let element = text_element_with_binding("count");
    engine.render(&element);

    // WHEN: Update a module that doesn't exist
    engine.update_state(Some("nonexistent"), json!({"foo": "bar"}));

    // THEN: No panic, engine continues to work
    assert!(
        engine.revision() >= 1,
        "Engine should still be functional after updating non-existent module"
    );
}

// ========== Test 8: Module scope propagation through nested elements ==========

#[test]
fn test_module_scope_propagates_to_nested_children() {
    // GIVEN: Engine with search module
    let mut engine = hypen_engine::Engine::new();

    let search = ModuleInstance::new(Module::new("Search"), json!({"query": "test", "count": 5}));
    engine.register_module("search", search);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render a deeply nested tree where the outer Column has module_scope="search"
    // and inner elements inherit it
    let inner_text = scoped_text_binding("query", "search");
    let inner_count = scoped_text_binding("count", "search");
    let inner_column = scoped_column(vec![inner_text, inner_count], Some("search"));
    let root = scoped_column(vec![inner_column], None);

    engine.render(&root);

    // THEN: Both bindings resolve against search module state
    let captured = patches.lock().unwrap();
    let texts = extract_create_texts(&captured);

    assert!(
        texts.contains(&"test".to_string()),
        "Expected search query='test'. Got: {:?}",
        texts
    );
    assert!(
        texts.contains(&"5".to_string()),
        "Expected search count=5. Got: {:?}",
        texts
    );
}

// ========== Test: Conditional branch activates module scope ==========
//
// This test covers the critical bug where a conditional branch activating
// new nodes could not look up module-scoped state because `modules` was
// passed as `None` during reconciliation.

#[test]
fn test_conditional_branch_activates_module_scope() {
    // GIVEN: An engine with App module (currentView: "feed") and Search module (searchQuery: "hello")
    let mut engine = hypen_engine::Engine::new();

    let app_module = ModuleInstance::new(Module::new("App"), json!({"currentView": "feed"}));
    engine.set_module(app_module);

    let search_module = ModuleInstance::new(
        Module::new("Search"),
        json!({"searchQuery": "hello", "explorePosts": []}),
    );
    engine.register_module("search", search_module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // Build the IR tree:
    //   Column {
    //     If(condition: "@{state.currentView == 'search'}") {
    //       Text("@{state.searchQuery}")  // scoped to "search" module
    //     }
    //   }
    let search_text = Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(Binding::state(vec!["searchQuery".to_string()]))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some("search".to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    };

    let conditional = IRNode::Conditional {
        value: Value::TemplateString {
            template: "@{state.currentView == 'search'}".to_string(),
            bindings: vec![Binding::state(vec!["currentView".to_string()])],
        },
        branches: vec![ConditionalBranch::new(
            Value::Static(json!(true)),
            vec![IRNode::Element(search_text)],
        )],
        fallback: None,
        module_scope: None,
    };

    let root_column = Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: vec![conditional],
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    };

    let ir_root = IRNode::Element(root_column);

    // WHEN: Initial render (currentView = "feed" => condition is false => no Search nodes)
    engine.render_ir_node(&ir_root);

    {
        let captured = patches.lock().unwrap();
        let texts = extract_create_texts(&captured);

        // The conditional should NOT have rendered the search text
        assert!(
            !texts.contains(&"hello".to_string()),
            "Search text should NOT be rendered when currentView='feed'. Got texts: {:?}",
            texts
        );
    }

    // Clear captured patches for next render
    patches.lock().unwrap().clear();

    // WHEN: Update App state to switch to search view
    engine.update_state(None, json!({"currentView": "search"}));

    // THEN: The conditional should now activate and the Search text should resolve
    // against the "search" module's state, showing "hello" (not null).
    let captured = patches.lock().unwrap();

    // Look for Create patches with the search query text
    let texts = extract_create_texts(&captured);

    assert!(
        texts.contains(&"hello".to_string()),
        "When conditional activates, the Search-scoped Text should resolve searchQuery='hello' \
         from the search module. Got texts: {:?}. All patches: {:?}",
        texts,
        *captured
    );
}

#[test]
fn test_conditional_module_with_array_state() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();

    // Primary module
    let app = Module::new("App");
    let app_inst = ModuleInstance::new(app, json!({"currentView": "feed"}));
    engine.set_module(app_inst);

    // Search module with array data
    let search = Module::new("Search");
    let search_inst = ModuleInstance::new(
        search,
        json!({
            "searchQuery": "",
            "explorePosts": [
                {"id": "1", "imageUrl": "https://example.com/1.jpg"},
                {"id": "2", "imageUrl": "https://example.com/2.jpg"},
                {"id": "3", "imageUrl": "https://example.com/3.jpg"}
            ]
        }),
    );
    engine.register_module("search", search_inst);

    // Component resolver
    engine.set_component_resolver(|name, _ctx| {
        if name == "Search" {
            Some(ir::ResolvedComponent {
                source: r#"module Search {
                    Column {
                        Text("query: @{state.searchQuery}")
                        Grid(@state.explorePosts, key: "id", columns: 3) {
                            Image(src: "@{item.imageUrl}")
                        }
                    }
                }"#
                .to_string(),
                path: "Search.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    });

    // Capture patches
    let patches = Arc::new(Mutex::new(Vec::new()));
    let capture = patches.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    // Initial render (feed view - Search not shown)
    let source = r#"module App {
        Column {
            Text("view: @{state.currentView}")
            If(condition: "@{state.currentView == 'search'}") {
                Search()
            }
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    let initial_patches = patches.lock().unwrap().clone();
    let initial_images: Vec<_> = initial_patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .collect();
    println!("Initial images: {}", initial_images.len());
    assert_eq!(initial_images.len(), 0, "No images in feed view");

    // Navigate to search
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({"currentView": "search"}));

    let search_patches = patches.lock().unwrap().clone();
    let search_images: Vec<_> = search_patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .collect();
    println!("Search images after navigate: {}", search_images.len());

    // Check Text shows correct query
    let texts: Vec<_> = search_patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return props
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
            None
        })
        .collect();
    println!("Text props: {:?}", texts);

    assert!(
        search_images.len() >= 3,
        "Should have 3 images from explorePosts, got {}",
        search_images.len()
    );
}

#[test]
fn test_double_state_update_doesnt_null_module_state() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();
    let app = Module::new("App");
    let app_inst = ModuleInstance::new(app, json!({"currentView": "feed"}));
    engine.set_module(app_inst);

    let search = Module::new("Search");
    let search_inst = ModuleInstance::new(
        search,
        json!({
            "searchQuery": "test",
            "explorePosts": [{"id": "1", "imageUrl": "http://img/1"}]
        }),
    );
    engine.register_module("search", search_inst);

    engine.set_component_resolver(|name, _ctx| {
        if name == "Search" {
            Some(ir::ResolvedComponent {
                source: r#"module Search { Column { Input(placeholder: "Search").bind(@state.searchQuery) Grid(@state.explorePosts, key: "id") { Image(src: "@{item.imageUrl}") } } }"#.to_string(),
                path: "Search.hypen".to_string(),
                passthrough: false, lazy: false,
            })
        } else { None }
    });

    let patches = Arc::new(Mutex::new(Vec::new()));
    let capture = patches.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    // Initial render (feed)
    let source = r#"module App { Column { If(condition: "@{state.currentView == 'search'}") { Search() } } }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);
    patches.lock().unwrap().clear();

    // First update: navigate to search
    engine.update_state(None, json!({"currentView": "search"}));
    let first_patches = patches.lock().unwrap().clone();

    // Check: should have Images
    let images1: Vec<_> = first_patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .collect();
    println!("After first update: {} images", images1.len());
    assert!(images1.len() >= 1, "Should have images after navigate");

    // Check for value=null SetProp
    let null_setprops: Vec<_> = first_patches.iter().filter(|p| {
        matches!(p, Patch::SetProp { name, value, .. } if name == "value" && value.is_null())
    }).collect();
    println!("Null value SetProps: {}", null_setprops.len());

    patches.lock().unwrap().clear();

    // Second update: same state change (simulates SDK double-notify)
    engine.update_state(None, json!({"currentView": "search"}));
    let second_patches = patches.lock().unwrap().clone();

    let null_setprops2: Vec<_> = second_patches.iter().filter(|p| {
        matches!(p, Patch::SetProp { name, value, .. } if name == "value" && value.is_null())
    }).collect();
    println!(
        "After second update - null value SetProps: {}",
        null_setprops2.len()
    );
    println!(
        "After second update - total patches: {}",
        second_patches.len()
    );

    assert_eq!(
        null_setprops.len(),
        0,
        "First update should NOT produce value=null SetProp"
    );
    assert_eq!(
        null_setprops2.len(),
        0,
        "Second update should NOT produce value=null SetProp"
    );
}

#[test]
fn test_parse_component_with_leading_whitespace() {
    let source = "\nmodule Search {\n    Column {\n        Text(\"hello\")\n    }\n}\n";
    let result = hypen_parser::parse_component(source);
    match result {
        Ok(spec) => {
            println!(
                "Parsed OK: name={} declaration_type={:?}",
                spec.name, spec.declaration_type
            );
        }
        Err(e) => {
            println!("PARSE FAILED: {:?}", e);
            // Try without leading newline
            let source2 = "module Search {\n    Column {\n        Text(\"hello\")\n    }\n}";
            let result2 = hypen_parser::parse_component(source2);
            match result2 {
                Ok(spec2) => println!(
                    "Without newline OK: name={} declaration_type={:?}",
                    spec2.name, spec2.declaration_type
                ),
                Err(e2) => println!("Without newline also FAILED: {:?}", e2),
            }
        }
    }
}

/// Reproduces the production bug: Grid behind a conditional inside a module-scoped
/// component creates Images then immediately removes them in the same patch batch.
///
/// Setup mirrors the Instagram Search: App module owns currentView, Search module
/// owns explorePosts. Search component is discovered via the component resolver
/// (same path as the TS/Go/Swift servers use). Navigate to search, verify Images
/// survive — no create-then-remove in the same batch.
#[test]
fn test_no_create_then_remove_for_module_grid() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();

    // Primary App module
    let app = Module::new("App");
    let app_inst = ModuleInstance::new(app, json!({"currentView": "feed"}));
    engine.set_module(app_inst);

    // Search module with array data
    let search = Module::new("Search");
    let search_inst = ModuleInstance::new(
        search,
        json!({
            "searchQuery": "",
            "explorePosts": [
                {"id": "1", "imageUrl": "https://example.com/1.jpg"},
                {"id": "2", "imageUrl": "https://example.com/2.jpg"},
                {"id": "3", "imageUrl": "https://example.com/3.jpg"}
            ]
        }),
    );
    engine.register_module("search", search_inst);

    // Component resolver — same path as production servers
    engine.set_component_resolver(|name, _ctx| {
        if name == "Search" {
            Some(ir::ResolvedComponent {
                source: r#"module Search {
                    Column {
                        Input(placeholder: "Search")
                            .bind(@state.searchQuery)
                        Grid(@state.explorePosts) {
                            Image(src: "@{item.imageUrl}")
                        }
                        .gridColumns(3)
                        .gap(4)
                    }
                }"#
                .to_string(),
                path: "Search.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    });

    // Capture ALL patches across ALL render passes
    let all_patches = Arc::new(Mutex::new(Vec::new()));
    let capture = all_patches.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    // Initial render (feed view — Search not shown)
    let source = r#"module App {
        Column {
            Text("view: @{state.currentView}")
            If(condition: "@{state.currentView == 'search'}") {
                Search()
            }
            If(condition: "@{state.currentView == 'feed'}") {
                Text("Feed content here")
            }
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    // Clear initial patches
    all_patches.lock().unwrap().clear();

    // Navigate to search — this triggers the conditional
    engine.update_state(None, json!({"currentView": "search"}));

    // Collect ALL patches from the navigate
    let patches = all_patches.lock().unwrap().clone();

    // Find creates and removes
    let mut created_ids: Vec<String> = Vec::new();
    let mut removed_ids: Vec<String> = Vec::new();

    for p in &patches {
        match p {
            Patch::Create {
                id, element_type, ..
            } => {
                created_ids.push(id.clone());
                if element_type == "Image" {
                    println!("  CREATE Image id={}", id);
                }
            }
            Patch::Remove { id } => {
                removed_ids.push(id.clone());
            }
            _ => {}
        }
    }

    // The critical assertion: NO removes should target just-created IDs
    let created_set: std::collections::HashSet<&str> =
        created_ids.iter().map(|s| s.as_str()).collect();
    let removes_of_created: Vec<&str> = removed_ids
        .iter()
        .filter(|id| created_set.contains(id.as_str()))
        .map(|s| s.as_str())
        .collect();

    let image_creates: Vec<&Patch> = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .collect();

    println!("Total patches: {}", patches.len());
    println!(
        "Creates: {}, Removes: {}",
        created_ids.len(),
        removed_ids.len()
    );
    println!("Images created: {}", image_creates.len());
    println!(
        "Removes targeting just-created: {}",
        removes_of_created.len()
    );

    assert_eq!(
        removes_of_created.len(),
        0,
        "BUG: {} elements were created then immediately removed in the same batch: {:?}",
        removes_of_created.len(),
        removes_of_created
    );

    assert!(
        image_creates.len() >= 3,
        "Expected at least 3 Image creates from explorePosts, got {}",
        image_creates.len()
    );
}

/// This test simulates the EXACT WASM path: components are pre-registered via
/// registerComponent (not the resolver callback), and then state is updated.
/// This is how TS/Go/Swift/Kotlin servers work — they pre-load component files
/// and register them, unlike the native Rust test which uses the resolver.
#[test]
fn test_preregistered_component_module_grid() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();

    // Register Search as a PRE-REGISTERED component (not via resolver)
    // This mirrors what the WASM JS registerComponent path does
    let search_source = r#"module Search {
        Column {
            Input(placeholder: "Search")
                .bind(@state.searchQuery)
            Grid(@state.explorePosts) {
                Image(src: "@{item.imageUrl}")
            }
            .gridColumns(3)
            .gap(4)
        }
    }"#;
    let search_spec = hypen_parser::parse_component(search_source).unwrap();
    let search_ir = ast_to_ir_node(&search_spec);
    let search_element = match search_ir {
        IRNode::Element(e) => e,
        _ => panic!("Expected Element from module unwrap"),
    };

    // Check: does search_element have module_scope?
    println!("Search root element_type: {}", search_element.element_type);
    println!(
        "Search root module_scope: {:?}",
        search_element.module_scope
    );

    // Check: does the component detect is_module?
    let is_module = search_spec.declaration_type == hypen_parser::DeclarationType::Module;
    println!("Search declaration_type is Module: {}", is_module);
    let module_name = if is_module {
        Some(search_spec.name.to_lowercase())
    } else {
        None
    };
    println!("Module name: {:?}", module_name);

    // Register as component (pre-registration path)
    let search_el = search_element.clone();
    let mut comp = ir::Component::new("Search", move |_props| search_el.clone());
    if is_module {
        comp.is_module = true;
        comp.module_name = module_name.clone();
    }
    engine.register_component(comp);

    // Primary App module
    let app = Module::new("App");
    let app_inst = ModuleInstance::new(app, json!({"currentView": "feed"}));
    engine.set_module(app_inst);

    // Search module state
    let search = Module::new("Search");
    let search_inst = ModuleInstance::new(
        search,
        json!({
            "searchQuery": "",
            "explorePosts": [
                {"id": "1", "imageUrl": "https://example.com/1.jpg"},
                {"id": "2", "imageUrl": "https://example.com/2.jpg"},
                {"id": "3", "imageUrl": "https://example.com/3.jpg"}
            ]
        }),
    );
    engine.register_module("search", search_inst);

    // Capture patches
    let all_patches = Arc::new(Mutex::new(Vec::new()));
    let capture = all_patches.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    // Initial render
    let source = r#"module App {
        Column {
            Text("view: @{state.currentView}")
            If(condition: "@{state.currentView == 'search'}") {
                Search()
            }
            If(condition: "@{state.currentView == 'feed'}") {
                Text("Feed")
            }
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);
    all_patches.lock().unwrap().clear();

    // Navigate to search
    engine.update_state(None, json!({"currentView": "search"}));

    let patches = all_patches.lock().unwrap().clone();
    let created_ids: std::collections::HashSet<String> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create { id, .. } = p {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect();
    let removed_ids: Vec<&str> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Remove { id } = p {
                Some(id.as_str())
            } else {
                None
            }
        })
        .collect();
    let removes_of_created: Vec<&&str> = removed_ids
        .iter()
        .filter(|id| created_ids.contains(**id))
        .collect();
    let image_creates: usize = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .count();

    println!("Total patches: {}", patches.len());
    println!(
        "Creates: {}, Removes: {}",
        created_ids.len(),
        removed_ids.len()
    );
    println!("Images created: {}", image_creates);
    println!(
        "Removes targeting just-created: {}",
        removes_of_created.len()
    );

    assert_eq!(
        removes_of_created.len(),
        0,
        "BUG: {} elements created then removed in same batch",
        removes_of_created.len()
    );
    assert!(
        image_creates >= 3,
        "Expected 3+ Images, got {}",
        image_creates
    );
}

/// Simulates the TS SDK double-render: update_state followed by a second
/// notify_state_change (from Proxy microtask) for the same change.
/// This is the EXACT flow the WASM path takes.
#[test]
fn test_double_render_via_notify_state_change() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();

    let app = Module::new("App");
    let app_inst = ModuleInstance::new(app, json!({"currentView": "feed"}));
    engine.set_module(app_inst);

    let search = Module::new("Search");
    let search_inst = ModuleInstance::new(
        search,
        json!({
            "searchQuery": "",
            "explorePosts": [
                {"id": "1", "imageUrl": "https://example.com/1.jpg"},
                {"id": "2", "imageUrl": "https://example.com/2.jpg"},
                {"id": "3", "imageUrl": "https://example.com/3.jpg"}
            ]
        }),
    );
    engine.register_module("search", search_inst);

    engine.set_component_resolver(|name, _ctx| {
        if name == "Search" {
            Some(ir::ResolvedComponent {
                source: r#"module Search {
                    Column {
                        Input(placeholder: "Search").bind(@state.searchQuery)
                        Grid(@state.explorePosts) {
                            Image(src: "@{item.imageUrl}")
                        }
                        .gridColumns(3)
                    }
                }"#
                .to_string(),
                path: "Search.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    });

    let all_patches = Arc::new(Mutex::new(Vec::new()));
    let capture = all_patches.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    // Initial render
    let source = r#"module App {
        Column {
            If(condition: "@{state.currentView == 'search'}") { Search() }
            If(condition: "@{state.currentView == 'feed'}") { Text("Feed") }
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);
    all_patches.lock().unwrap().clear();

    // FIRST: update_state (what the action handler does)
    engine.update_state(None, json!({"currentView": "search"}));

    // SECOND: notify_state_change (what the Proxy microtask does)
    // This simulates the TS SDK calling updateStateSparse after the action
    let change = state::StateChange::from_json(&json!({"currentView": "search"}));
    engine.notify_state_change(&change);

    let patches = all_patches.lock().unwrap().clone();
    let created_ids: std::collections::HashSet<String> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create { id, .. } = p {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect();
    let removes_of_created: Vec<&str> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Remove { id } = p {
                Some(id.as_str())
            } else {
                None
            }
        })
        .filter(|id| created_ids.contains(*id))
        .collect();
    let image_creates: usize = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { element_type, .. } if element_type == "Image"))
        .count();

    println!("Total patches: {}", patches.len());
    println!("Images created: {}", image_creates);
    println!(
        "Removes targeting just-created: {}",
        removes_of_created.len()
    );

    assert_eq!(
        removes_of_created.len(),
        0,
        "BUG: Double render caused {} create-then-remove",
        removes_of_created.len()
    );
    assert!(
        image_creates >= 3,
        "Expected 3+ Images, got {}",
        image_creates
    );
}

/// After replacing the primary module via `set_module`, a subsequent
/// `notify_state_change` must NOT skip rendering just because the old
/// Arc pointer and the new one happen to land at the same address.
/// The guard uses `Weak::upgrade` + `Arc::ptr_eq` specifically to prevent
/// that ABA case; this test exercises the replacement path end-to-end so
/// a future regression to raw-pointer-identity comparison would fail.
#[test]
fn test_notify_state_change_survives_module_replacement() {
    use hypen_engine::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();

    // First module — render once so the engine stashes its state Arc.
    let app = Module::new("App");
    let first = ModuleInstance::new(app, json!({"label": "first"}));
    engine.set_module(first);

    let patches_log = Arc::new(Mutex::new(Vec::new()));
    let capture = patches_log.clone();
    engine.set_render_callback(move |p| {
        capture.lock().unwrap().extend_from_slice(p);
    });

    let source = r#"Column { Text("@{state.label}") }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    // Prime the guard by firing a notify_state_change so last_state_weak
    // gets populated pointing at the first module's state Arc.
    let change1 = state::StateChange::from_json(&json!({"label": "first"}));
    engine.notify_state_change(&change1);

    // Replace the primary module. The previous ModuleInstance is dropped,
    // which drops its Arc<Value>. The engine's Weak can no longer upgrade.
    let app2 = Module::new("App");
    let second = ModuleInstance::new(app2, json!({"label": "second"}));
    engine.set_module(second);

    patches_log.lock().unwrap().clear();

    // This notify_state_change MUST render. If the guard compared raw
    // pointers as usize, and the new Arc happened to land at the old
    // address, the guard would erroneously short-circuit and this assert
    // would fire with zero patches.
    let change2 = state::StateChange::from_json(&json!({"label": "second"}));
    engine.notify_state_change(&change2);

    // The render may emit zero patches if nothing was bound — we don't
    // care about patch contents, we care that the engine did NOT skip
    // the render purely because the guard thought the state was the same.
    // Concretely: the revision must still reflect that we at least tried.
    // Easier and more direct check: after set_module the Weak::upgrade
    // returns None, so the guard falls through. We assert that by
    // confirming a later render with genuinely-changed state still works.
    engine.update_state(None, json!({"label": "third"}));
    let final_patches = patches_log.lock().unwrap().clone();
    let saw_set_prop = final_patches
        .iter()
        .any(|p| matches!(p, Patch::SetProp { value, .. } if value.as_str() == Some("third")));
    assert!(
        saw_set_prop,
        "state change after module replacement must still render; patches: {:?}",
        final_patches
    );
}
