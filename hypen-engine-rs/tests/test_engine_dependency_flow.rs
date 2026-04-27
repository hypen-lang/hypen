/// Test to debug the exact flow of Engine dependency tracking and state updates
use hypen_engine::{
    ir::{Element, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::Binding,
    Engine,
};
use serde_json::json;

#[test]
fn test_engine_tracks_dependencies_after_render() {
    // GIVEN: Engine with module and element with binding
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    // WHEN: Render
    engine.render(&element);

    // THEN: Should have dependencies tracked
    // (We can't directly access engine.dependencies, but we can test the effect)
    assert_eq!(
        engine.revision(),
        1,
        "Should have revision 1 after first render"
    );
}

#[test]
fn test_engine_update_state_finds_affected_nodes() {
    // GIVEN: Rendered engine with binding
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Update state
    engine.update_state(None, json!({"count": 1}));

    // THEN: Revision should increment
    // This tests the full flow: dependency tracking → state change → dirty marking → patch generation
    assert_eq!(
        engine.revision(),
        2,
        "Revision should increment after state update if dependencies are tracked and patches are generated"
    );
}

#[test]
fn test_engine_multiple_state_updates() {
    // GIVEN: Rendered engine
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    engine.render(&element);
    assert_eq!(engine.revision(), 1);

    // WHEN: Multiple updates
    engine.update_state(None, json!({"count": 1}));
    assert_eq!(engine.revision(), 2, "First update");

    engine.update_state(None, json!({"count": 2}));
    assert_eq!(engine.revision(), 3, "Second update");

    engine.update_state(None, json!({"count": 3}));
    assert_eq!(engine.revision(), 4, "Third update");
}
