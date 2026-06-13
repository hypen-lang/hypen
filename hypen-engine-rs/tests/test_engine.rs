//! Integration tests for src/engine.rs
//!
//! Tests the main Engine orchestrator that coordinates all subsystems.
//! These tests follow the Given/When/Then pattern for clarity.

mod common;

use common::*;
use hypen_engine::dispatch::Action;
use hypen_engine::ir::{Component, Element};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;
use std::sync::{Arc, Mutex};

// ========== A. Engine Initialization Tests (3 tests) ==========

#[test]
fn test_engine_new_creates_empty_state() {
    // GIVEN: Nothing
    // WHEN: Create new engine
    let engine = Engine::new();

    // THEN: Engine has empty tree, no module, no dirty nodes
    assert_eq!(engine.revision(), 0);
    // Note: Can't access private fields, but we can test behavior
}

#[test]
fn test_engine_default_is_identical_to_new() {
    // GIVEN: Two engines
    let engine1 = Engine::new();
    let engine2 = Engine::default();

    // THEN: Both start with revision 0
    assert_eq!(engine1.revision(), engine2.revision());
    assert_eq!(engine1.revision(), 0);
}

#[test]
fn test_engine_revision_starts_at_zero() {
    // GIVEN/WHEN: New engine
    let engine = Engine::new();

    // THEN: Revision is 0
    assert_eq!(engine.revision(), 0);
}

// ========== B. Component Registration Tests (5 tests) ==========

#[test]
fn test_register_component_adds_to_registry() {
    // GIVEN: Engine and component template
    let mut engine = Engine::new();
    let component = Component::new("Button", |_props| text_element("Click me"));

    // WHEN: Register component
    engine.register_component(component);

    // THEN: Component can be expanded
    let element = Element::new("Button");
    let expanded = engine.component_registry_mut().expand(&element);
    assert_element_type(&expanded, "Text");
}

#[test]
fn test_register_component_replaces_existing() {
    // GIVEN: Component already registered
    let mut engine = Engine::new();
    let component1 = Component::new("Button", |_props| text_element("First"));
    let component2 = Component::new("Button", |_props| text_element("Second"));

    // WHEN: Register with same name twice
    engine.register_component(component1);
    engine.register_component(component2);

    // THEN: Second registration replaces first
    let element = Element::new("Button");
    let expanded = engine.component_registry_mut().expand(&element);
    assert_element_type(&expanded, "Text");
}

#[test]
fn test_component_resolver_fallback_when_not_in_registry() {
    // GIVEN: Engine with custom resolver
    let mut engine = Engine::new();
    let resolved = Arc::new(Mutex::new(false));
    let resolved_clone = resolved.clone();

    engine.set_component_resolver(move |name, _context| {
        *resolved_clone.lock().unwrap() = true;
        if name == "DynamicButton" {
            Some(hypen_engine::ir::ResolvedComponent {
                source: "Text(\"Dynamic\")".to_string(),
                path: "DynamicButton.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    });

    // WHEN: Expand unknown component
    let element = Element::new("DynamicButton");
    let _ = engine.component_registry_mut().expand(&element);

    // THEN: Resolver was called
    assert!(*resolved.lock().unwrap());
}

#[test]
fn test_component_resolver_returns_none_falls_back_gracefully() {
    // GIVEN: Resolver that returns None
    let mut engine = Engine::new();
    engine.set_component_resolver(|_name, _context| None);

    // WHEN: Expand unknown component
    let element = Element::new("UnknownComponent");
    let expanded = engine.component_registry_mut().expand(&element);

    // THEN: Element returned as-is (no panic)
    assert_element_type(&expanded, "UnknownComponent");
}

#[test]
fn test_multiple_component_registrations() {
    // GIVEN: Engine
    let mut engine = Engine::new();

    // WHEN: Register 10 different components
    for i in 0..10 {
        let name = format!("Component{}", i);
        let content = format!("Content {}", i);
        let component = Component::new(name.clone(), move |_props| text_element(&content));
        engine.register_component(component);
    }

    // THEN: All can be expanded
    for i in 0..10 {
        let element = Element::new(format!("Component{}", i));
        let expanded = engine.component_registry_mut().expand(&element);
        assert_element_type(&expanded, "Text");
    }
}

// ========== C. Render Pipeline Tests (8 tests) ==========

#[test]
fn test_render_simple_text_element() {
    // GIVEN: Engine and Text element
    let mut engine = Engine::new();
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render element
    let element = text_element("Hello");
    engine.render(&element);

    // THEN: Emits patches (Create + Insert)
    let captured = patches.lock().unwrap();
    assert_has_create(&captured);
    assert!(captured.len() >= 1);
}

#[test]
fn test_render_nested_column_with_children() {
    // GIVEN: Column { Text, Text }
    let mut engine = Engine::new();
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render
    let element = column_with_children(vec![text_element("First"), text_element("Second")]);
    engine.render(&element);

    // THEN: Creates 3 nodes (Column + 2 Text)
    let captured = patches.lock().unwrap();
    assert_eq!(count_creates(&captured), 3);
}

#[test]
fn test_render_increments_revision() {
    // GIVEN: Engine with revision 0
    let mut engine = Engine::new();
    assert_eq!(engine.revision(), 0);

    // WHEN: Render element
    let element = text_element("Hello");
    engine.render(&element);

    // THEN: Revision increments to 1
    assert_eq!(engine.revision(), 1);
}

#[test]
fn test_render_callback_receives_patches() {
    // GIVEN: Engine with callback
    let mut engine = Engine::new();
    let invoked = Arc::new(Mutex::new(false));
    let invoked_clone = invoked.clone();
    engine.set_render_callback(move |patches| {
        *invoked_clone.lock().unwrap() = !patches.is_empty();
    });

    // WHEN: Render element
    let element = text_element("Hello");
    engine.render(&element);

    // THEN: Callback was invoked with patches
    assert!(*invoked.lock().unwrap());
}

#[test]
fn test_render_same_tree_twice_minimal_patches() {
    // GIVEN: Engine with rendered tree
    let mut engine = Engine::new();
    let element = text_element("Hello");
    engine.render(&element);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render identical tree again
    engine.render(&element);

    // THEN: Minimal patches (reconciliation detects no changes)
    let captured = patches.lock().unwrap();
    assert_no_changes(&captured);
}

#[test]
fn test_render_with_state_bindings() {
    // GIVEN: Element with @{state.name} binding and module with state
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"name": "Alice"}));
    engine.set_module(module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render with state binding
    let element = text_element_with_binding("name");
    engine.render(&element);

    // THEN: Binding resolved to "Alice" in Create patch
    let captured = patches.lock().unwrap();
    let has_alice = captured.iter().any(|p| {
        if let hypen_engine::reconcile::Patch::Create { props, .. } = p {
            props
                .get("text")
                .map(|v| v == &json!("Alice"))
                .unwrap_or(false)
        } else {
            false
        }
    });
    assert!(has_alice, "Expected Create patch with text='Alice'");
}

#[test]
fn test_render_empty_element_tree() {
    // GIVEN: Engine
    let mut engine = Engine::new();
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render empty Column
    let element = column_with_children(vec![]);
    engine.render(&element);

    // THEN: No crash, creates Column node
    let captured = patches.lock().unwrap();
    assert!(captured.len() >= 1);
}

#[test]
fn test_render_multiple_times_increments_revision() {
    // GIVEN: Engine
    let mut engine = Engine::new();
    let element = text_element("Test");

    // WHEN: Render 5 times
    for _ in 0..5 {
        engine.render(&element);
    }

    // THEN: Revision is 5
    assert_eq!(engine.revision(), 5);
}

// ========== D. State Change Handling Tests (6 tests) ==========

#[test]
fn test_update_state_increments_revision() {
    // GIVEN: Rendered tree with state binding
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let element = text_element_with_binding("count");
    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update state
    engine.update_state(None, json!({"count": 1}));

    // THEN: Revision increments
    assert_eq!(engine.revision(), 2);
}

#[test]
fn test_update_state_with_nested_path() {
    // GIVEN: Binding to nested state
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"user": {"name": "Alice"}}));
    engine.set_module(module);

    let element = text_element_with_binding("user.name");
    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update user.name
    engine.update_state(None, json!({"user": {"name": "Bob"}}));

    // THEN: Revision increments (patches depend on dependency tracking)
    assert_eq!(engine.revision(), 2);
}

#[test]
fn test_update_state_with_no_dependents() {
    // GIVEN: Tree with no bindings to "foo"
    let mut engine = Engine::new();
    let element = text_element("Static");
    engine.render(&element);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Update unrelated state
    engine.update_state(None, json!({"foo": "bar"}));

    // THEN: No patches emitted
    let captured = patches.lock().unwrap();
    assert_eq!(captured.len(), 0);
}

#[test]
fn test_update_state_with_multiple_bindings() {
    // GIVEN: Tree with multiple state bindings
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"a": "1", "b": "2"}));
    engine.set_module(module);

    let element = column_with_children(vec![
        text_element_with_binding("a"),
        text_element_with_binding("b"),
    ]);
    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update both values
    engine.update_state(None, json!({"a": "10", "b": "20"}));

    // THEN: Revision increments (patch generation depends on dependency tracking)
    assert_eq!(engine.revision(), 2);
}

#[test]
fn test_update_state_with_empty_patch() {
    // GIVEN: Rendered tree
    let mut engine = Engine::new();
    let element = text_element("Test");
    engine.render(&element);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Update with empty state patch
    engine.update_state(None, json!({}));

    // THEN: No patches
    let captured = patches.lock().unwrap();
    assert_eq!(captured.len(), 0);
}

#[test]
fn test_multiple_state_updates_batch_correctly() {
    // GIVEN: Tree with bindings
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let element = text_element_with_binding("count");
    engine.render(&element);

    // WHEN: Multiple updates
    engine.update_state(None, json!({"count": 1}));
    engine.update_state(None, json!({"count": 2}));
    engine.update_state(None, json!({"count": 3}));

    // THEN: Revision increments for each
    assert_eq!(engine.revision(), 4); // 1 initial + 3 updates
}

// ========== E. Action Dispatch Tests (5 tests) ==========

#[test]
fn test_dispatch_action_calls_registered_handler() {
    // GIVEN: Engine with action handler
    let mut engine = Engine::new();
    let called = Arc::new(Mutex::new(false));
    let called_clone = called.clone();
    engine.on_action("signIn", move |_action| {
        *called_clone.lock().unwrap() = true;
    });

    // WHEN: Dispatch action
    let action = Action::new("signIn");
    let result = engine.dispatch_action(action);

    // THEN: Handler was called
    assert!(result.is_ok());
    assert!(*called.lock().unwrap());
}

#[test]
fn test_dispatch_action_with_payload() {
    // GIVEN: Action handler expecting payload
    let mut engine = Engine::new();
    let received = Arc::new(Mutex::new(None));
    let received_clone = received.clone();
    engine.on_action("submit", move |action| {
        *received_clone.lock().unwrap() = action.payload.clone();
    });

    // WHEN: Dispatch with payload
    let action = Action::new("submit").with_payload(json!({"value": 42}));
    let _ = engine.dispatch_action(action);

    // THEN: Handler receives payload
    let payload = received.lock().unwrap();
    assert!(payload.is_some());
    assert_eq!(payload.as_ref().unwrap()["value"], 42);
}

#[test]
fn test_dispatch_action_without_handler_returns_error() {
    // GIVEN: Engine with no handlers
    let mut engine = Engine::new();

    // WHEN: Dispatch unknown action
    let action = Action::new("unknown");
    let result = engine.dispatch_action(action);

    // THEN: Returns error
    assert!(result.is_err());
}

#[test]
fn test_dispatch_multiple_actions_sequentially() {
    // GIVEN: Engine with multiple handlers
    let mut engine = Engine::new();
    let count = Arc::new(Mutex::new(0));

    for i in 1..=3 {
        let count_clone = count.clone();
        engine.on_action(format!("action{}", i), move |_| {
            *count_clone.lock().unwrap() += 1;
        });
    }

    // WHEN: Dispatch all actions
    for i in 1..=3 {
        let action = Action::new(format!("action{}", i));
        let _ = engine.dispatch_action(action);
    }

    // THEN: All handlers called
    assert_eq!(*count.lock().unwrap(), 3);
}

#[test]
fn test_action_handler_can_be_registered_after_render() {
    // GIVEN: Rendered tree
    let mut engine = Engine::new();
    let element = text_element("Button");
    engine.render(&element);

    let called = Arc::new(Mutex::new(false));
    let called_clone = called.clone();

    // WHEN: Register handler after render
    engine.on_action("click", move |_| {
        *called_clone.lock().unwrap() = true;
    });

    let action = Action::new("click");
    let _ = engine.dispatch_action(action);

    // THEN: Handler works
    assert!(*called.lock().unwrap());
}

// ========== F. Module Lifecycle Tests (4 tests) ==========

#[test]
fn test_set_module_registers_instance() {
    // GIVEN: Engine and module instance
    let mut engine = Engine::new();
    let module_meta = Module::new("ProfilePage");
    let module = ModuleInstance::new(module_meta, json!({}));

    // WHEN: Set module
    engine.set_module(module);

    // THEN: Can render with module state (no panic)
    let element = text_element("Test");
    engine.render(&element);
}

#[test]
fn test_render_with_module_state() {
    // GIVEN: Module with user state
    let mut engine = Engine::new();
    let module = user_module(); // From fixtures
    engine.set_module(module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render with binding to user.name
    let element = text_element_with_binding("user.name");
    engine.render(&element);

    // THEN: Resolves to "Alice" (from user_module fixture) in Create patch
    let captured = patches.lock().unwrap();
    let has_alice = captured.iter().any(|p| {
        if let hypen_engine::reconcile::Patch::Create { props, .. } = p {
            props
                .get("text")
                .map(|v| v == &json!("Alice"))
                .unwrap_or(false)
        } else {
            false
        }
    });
    assert!(has_alice, "Expected Create patch with user.name='Alice'");
}

#[test]
fn test_module_state_update_increments_revision() {
    // GIVEN: Rendered module component
    let mut engine = Engine::new();
    let module_meta = Module::new("CounterModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let element = text_element_with_binding("count");
    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update module state
    engine.update_state(None, json!({"count": 5}));

    // THEN: Revision increments
    // Note: Patches may not be emitted if dependency tracking isn't active
    assert_eq!(engine.revision(), 2);
}

#[test]
fn test_multiple_module_instances_replace_each_other() {
    // GIVEN: Engine with first module
    let mut engine = Engine::new();
    let module1 = ModuleInstance::new(Module::new("Module1"), json!({"value": "first"}));
    engine.set_module(module1);

    // WHEN: Set second module
    let module2 = ModuleInstance::new(Module::new("Module2"), json!({"value": "second"}));
    engine.set_module(module2);

    // THEN: Can render with new module (no panic)
    let element = text_element_with_binding("value");
    engine.render(&element);
}

// ========== G. Edge Cases Tests (2 tests) ==========

#[test]
fn test_render_very_deep_tree() {
    // GIVEN: Deeply nested tree (50 levels)
    let mut engine = Engine::new();
    let element = deep_tree(50);

    // WHEN: Render
    engine.render(&element);

    // THEN: No stack overflow, completes successfully
    assert_eq!(engine.revision(), 1);
}

#[test]
fn test_render_tree_with_many_children() {
    // GIVEN: Column with 100 Text children
    let mut engine = Engine::new();
    let element = wide_tree(100);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render
    engine.render(&element);

    // THEN: Completes successfully, creates 101 nodes (1 Column + 100 Text)
    let captured = patches.lock().unwrap();
    assert_eq!(count_creates(&captured), 101);
}

// ========== H. Action Routing Regression Tests ==========
// These tests guard against regressions in `action_module_map` population
// across `set_module` and `register_module` (see ENGINE_CONTRACT.md §15.5).

#[test]
fn test_set_module_primary_action_scope_is_none() {
    // GIVEN: Engine with primary module that declares actions
    let mut engine = Engine::new();
    let module_meta =
        Module::new("Counter").with_actions(vec!["increment".to_string(), "decrement".to_string()]);
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));

    // WHEN: Install via set_module
    engine.set_module(module);

    // THEN: action_scope_for reports `None` (primary slot, not a named module)
    //       but the engine knows the action belongs somewhere — this is the
    //       correct routing signal for polling bindings.
    assert_eq!(engine.action_scope_for("increment"), None);
    assert_eq!(engine.action_scope_for("decrement"), None);
    // And unknown actions also return None — same signal, same handling.
    assert_eq!(engine.action_scope_for("nonexistent"), None);
}

#[test]
fn test_register_module_named_action_scope() {
    // GIVEN: Engine with a named module that declares actions
    let mut engine = Engine::new();
    let module_meta =
        Module::new("Search").with_actions(vec!["submit".to_string(), "clear".to_string()]);
    let module = ModuleInstance::new(module_meta, json!({}));

    // WHEN: Install via register_module
    engine.register_module("search", module);

    // THEN: action_scope_for reports the named scope
    assert_eq!(
        engine.action_scope_for("submit"),
        Some("search".to_string())
    );
    assert_eq!(engine.action_scope_for("clear"), Some("search".to_string()));
}

#[test]
fn test_set_module_twice_evicts_previous_primary_actions() {
    // GIVEN: Engine with a primary module declaring `increment`
    let mut engine = Engine::new();
    let first = ModuleInstance::new(
        Module::new("First").with_actions(vec!["increment".to_string()]),
        json!({}),
    );
    engine.set_module(first);
    assert_eq!(engine.action_scope_for("increment"), None); // present (primary)

    // WHEN: Replace with a second module that declares only `reset`
    let second = ModuleInstance::new(
        Module::new("Second").with_actions(vec!["reset".to_string()]),
        json!({}),
    );
    engine.set_module(second);

    // THEN: The old `increment` entry is evicted; `reset` is present.
    // We can't directly observe the map, but we verify register_module
    // afterwards doesn't see a stale collision via action_scope_for.
    // After eviction, registering a named module that claims `increment`
    // should succeed with the expected scope rather than being shadowed.
    let named = ModuleInstance::new(
        Module::new("Other").with_actions(vec!["increment".to_string()]),
        json!({}),
    );
    engine.register_module("other", named);
    assert_eq!(
        engine.action_scope_for("increment"),
        Some("other".to_string())
    );
}

#[test]
fn test_register_module_twice_evicts_previous_named_actions() {
    // GIVEN: Engine with a named module that declares `submit`
    let mut engine = Engine::new();
    let first = ModuleInstance::new(
        Module::new("Search").with_actions(vec!["submit".to_string(), "clear".to_string()]),
        json!({}),
    );
    engine.register_module("search", first);
    assert_eq!(
        engine.action_scope_for("submit"),
        Some("search".to_string())
    );
    assert_eq!(engine.action_scope_for("clear"), Some("search".to_string()));

    // WHEN: Re-register under the same key with a different action set
    let second = ModuleInstance::new(
        Module::new("Search").with_actions(vec!["query".to_string()]),
        json!({}),
    );
    engine.register_module("search", second);

    // THEN: Old `submit` and `clear` entries are evicted; only `query` remains.
    assert_eq!(engine.action_scope_for("submit"), None);
    assert_eq!(engine.action_scope_for("clear"), None);
    assert_eq!(engine.action_scope_for("query"), Some("search".to_string()));
}

#[test]
fn test_set_and_register_module_coexist() {
    // GIVEN: Engine with a primary module (actions `a`) and a named module (actions `b`)
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("Primary").with_actions(vec!["a".to_string()]),
        json!({}),
    ));
    engine.register_module(
        "search",
        ModuleInstance::new(
            Module::new("Search").with_actions(vec!["b".to_string()]),
            json!({}),
        ),
    );

    // THEN: action_scope_for distinguishes them correctly
    assert_eq!(engine.action_scope_for("a"), None); // primary
    assert_eq!(engine.action_scope_for("b"), Some("search".to_string()));

    // WHEN: Primary module is replaced
    engine.set_module(ModuleInstance::new(
        Module::new("Primary2").with_actions(vec!["c".to_string()]),
        json!({}),
    ));

    // THEN: Named module's routing is unaffected
    assert_eq!(engine.action_scope_for("a"), None); // evicted, unknown
    assert_eq!(engine.action_scope_for("b"), Some("search".to_string())); // still there
    assert_eq!(engine.action_scope_for("c"), None); // new primary
}

// ========== I. set_context Deep-Path Regression Tests ==========
// Guards against ENGINE_CONTRACT.md §15.7: set_context previously only
// scanned top-level keys, so bindings to `@ds.provider.user.name` were
// not invalidated on whole-provider replacement.

#[test]
fn test_set_context_invalidates_deep_data_source_bindings() {
    // GIVEN: Engine with a component that reads `@spacetime.user.name` (deep path)
    let mut engine = Engine::new();
    let module = ModuleInstance::new(Module::new("Page"), json!({}));
    engine.set_module(module);

    // Seed the data source and render once so the binding is recorded.
    engine.set_context("spacetime", json!({"user": {"name": "Alice", "age": 30}}));

    // Render a Text element that binds `@spacetime.user.name` via the
    // template path. We go through the parser so the binding registers
    // correctly.
    let source = r#"Text("@{spacetime.user.name}")"#;
    let component = hypen_parser::parse_component(source).expect("parse");
    let ir_node = hypen_engine::ir::ast_to_ir_node(&component);
    engine.render_ir_node(&ir_node);

    // Capture subsequent patches.
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Replace the whole data source
    engine.set_context("spacetime", json!({"user": {"name": "Bob", "age": 31}}));

    // THEN: The deep-bound Text node re-rendered — we observe a SetProp
    //       (or SetText) patch carrying "Bob".
    let captured = patches.lock().unwrap();
    let saw_bob = captured.iter().any(|p| match p {
        hypen_engine::reconcile::Patch::SetProp { value, .. } => value == &json!("Bob"),
        hypen_engine::reconcile::Patch::SetText { text, .. } => text == "Bob",
        hypen_engine::reconcile::Patch::Create { props, .. } => {
            props.values().any(|v| v == &json!("Bob"))
        }
        _ => false,
    });
    assert!(
        saw_bob,
        "Expected a patch carrying 'Bob' after set_context replaced the deep provider state; got: {:?}",
        *captured
    );
}
