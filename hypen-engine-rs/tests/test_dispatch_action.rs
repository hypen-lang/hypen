//! Tests for src/dispatch/action.rs - Action dispatching system
//!
//! Tests action creation, handler registration, and dispatch logic

use hypen_engine::dispatch::action::{Action, ActionDispatcher};
use serde_json::json;
use std::sync::{Arc, Mutex};

// ============================================================================
// Action Creation with Payload/Sender (3 tests)
// ============================================================================

#[test]
fn test_action_new() {
    // GIVEN/WHEN: Create new action
    let action = Action::new("signIn");

    // THEN: Action created with name only
    assert_eq!(action.name, "signIn");
    assert!(action.payload.is_none());
    assert!(action.sender.is_none());
}

#[test]
fn test_action_with_payload() {
    // GIVEN: Action with payload
    let action = Action::new("updateUser").with_payload(json!({
        "userId": 123,
        "name": "Alice"
    }));

    // THEN: Payload attached
    assert_eq!(action.name, "updateUser");
    assert!(action.payload.is_some());
    let payload = action.payload.as_ref().unwrap();
    assert_eq!(payload["userId"], 123);
    assert_eq!(payload["name"], "Alice");
}

#[test]
fn test_action_with_sender() {
    // GIVEN: Action with sender
    let action = Action::new("notify").with_sender("UserModule");

    // THEN: Sender attached
    assert_eq!(action.name, "notify");
    assert!(action.sender.is_some());
    assert_eq!(action.sender.unwrap(), "UserModule");
}

// ============================================================================
// Dispatcher Registration/Removal (4 tests)
// ============================================================================

#[test]
fn test_dispatcher_register_handler() {
    // GIVEN: ActionDispatcher
    let mut dispatcher = ActionDispatcher::new();

    // WHEN: Register handler
    dispatcher.on("increment", |_action| {
        // Handler logic
    });

    // THEN: Handler registered
    assert!(dispatcher.has_handler("increment"));
}

#[test]
fn test_dispatcher_multiple_handlers() {
    // GIVEN: ActionDispatcher
    let mut dispatcher = ActionDispatcher::new();

    // WHEN: Register multiple handlers
    dispatcher.on("action1", |_| {});
    dispatcher.on("action2", |_| {});
    dispatcher.on("action3", |_| {});

    // THEN: All handlers registered
    assert!(dispatcher.has_handler("action1"));
    assert!(dispatcher.has_handler("action2"));
    assert!(dispatcher.has_handler("action3"));
}

#[test]
fn test_dispatcher_remove_handler() {
    // GIVEN: Dispatcher with handler
    let mut dispatcher = ActionDispatcher::new();
    dispatcher.on("test", |_| {});
    assert!(dispatcher.has_handler("test"));

    // WHEN: Remove handler
    dispatcher.remove("test");

    // THEN: Handler removed
    assert!(!dispatcher.has_handler("test"));
}

#[test]
fn test_dispatcher_clear_all_handlers() {
    // GIVEN: Dispatcher with multiple handlers
    let mut dispatcher = ActionDispatcher::new();
    dispatcher.on("action1", |_| {});
    dispatcher.on("action2", |_| {});
    dispatcher.on("action3", |_| {});

    // WHEN: Clear all handlers
    dispatcher.clear();

    // THEN: All handlers removed
    assert!(!dispatcher.has_handler("action1"));
    assert!(!dispatcher.has_handler("action2"));
    assert!(!dispatcher.has_handler("action3"));
}

// ============================================================================
// Dispatch Edge Cases (3 tests)
// ============================================================================

#[test]
fn test_dispatch_with_payload_to_handler() {
    // GIVEN: Dispatcher with handler that captures payload
    let mut dispatcher = ActionDispatcher::new();
    let captured_payload = Arc::new(Mutex::new(None));
    let captured_clone = Arc::clone(&captured_payload);

    dispatcher.on("updateCount", move |action| {
        *captured_clone.lock().unwrap() = action.payload.clone();
    });

    // WHEN: Dispatch action with payload
    let action = Action::new("updateCount").with_payload(json!({"count": 42}));

    dispatcher.dispatch(&action).unwrap();

    // THEN: Handler receives payload
    let payload = captured_payload.lock().unwrap();
    assert!(payload.is_some());
    assert_eq!(payload.as_ref().unwrap()["count"], 42);
}

#[test]
fn test_dispatch_to_missing_handler_returns_error() {
    // GIVEN: Empty dispatcher
    let dispatcher = ActionDispatcher::new();

    // WHEN: Dispatch to unregistered action
    let action = Action::new("nonexistent");
    let result = dispatcher.dispatch(&action);

    // THEN: Returns ActionNotFound error
    assert!(result.is_err());
    match result.unwrap_err() {
        hypen_engine::EngineError::ActionNotFound(name) => {
            assert_eq!(name, "nonexistent");
        }
        other => panic!("Expected ActionNotFound, got: {:?}", other),
    }
}

#[test]
fn test_handler_replacement_on_duplicate_registration() {
    // GIVEN: Dispatcher with handler
    let mut dispatcher = ActionDispatcher::new();
    let first_called = Arc::new(Mutex::new(false));
    let second_called = Arc::new(Mutex::new(false));

    let first_clone = Arc::clone(&first_called);
    dispatcher.on("test", move |_| {
        *first_clone.lock().unwrap() = true;
    });

    // WHEN: Register second handler with same name (replaces first)
    let second_clone = Arc::clone(&second_called);
    dispatcher.on("test", move |_| {
        *second_clone.lock().unwrap() = true;
    });

    let action = Action::new("test");
    dispatcher.dispatch(&action).unwrap();

    // THEN: Only second handler called
    assert!(!(*first_called.lock().unwrap()));
    assert!(*second_called.lock().unwrap());
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_dispatcher_default() {
    // GIVEN/WHEN: Create using default
    let dispatcher = ActionDispatcher::default();

    // THEN: Same as new() (no handlers)
    assert!(!dispatcher.has_handler("anything"));
}

#[test]
fn test_action_builder_chain() {
    // GIVEN: Build action with chained methods
    let action = Action::new("complexAction")
        .with_payload(json!({"data": "test"}))
        .with_sender("TestModule");

    // THEN: All fields set correctly
    assert_eq!(action.name, "complexAction");
    assert_eq!(action.payload.unwrap()["data"], "test");
    assert_eq!(action.sender.unwrap(), "TestModule");
}

#[test]
fn test_action_serialization() {
    // GIVEN: Action with all fields
    let action = Action::new("testAction")
        .with_payload(json!({"value": 100}))
        .with_sender("Source");

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&action).unwrap();

    // THEN: All fields serialized
    assert_eq!(json["name"], "testAction");
    assert_eq!(json["payload"]["value"], 100);
    assert_eq!(json["sender"], "Source");
}

#[test]
fn test_action_deserialization() {
    // GIVEN: JSON representation
    let json = json!({
        "name": "deserializedAction",
        "payload": {"count": 5},
        "sender": "Client"
    });

    // WHEN: Deserialize from JSON
    let action: Action = serde_json::from_value(json).unwrap();

    // THEN: All fields deserialized correctly
    assert_eq!(action.name, "deserializedAction");
    assert_eq!(action.payload.unwrap()["count"], 5);
    assert_eq!(action.sender.unwrap(), "Client");
}

#[test]
fn test_remove_nonexistent_handler_no_panic() {
    // GIVEN: Empty dispatcher
    let mut dispatcher = ActionDispatcher::new();

    // WHEN: Remove nonexistent handler
    dispatcher.remove("nonexistent");

    // THEN: No panic (operation is safe)
    assert!(!dispatcher.has_handler("nonexistent"));
}

#[test]
fn test_dispatch_multiple_times_to_same_handler() {
    // GIVEN: Dispatcher with counter handler
    let mut dispatcher = ActionDispatcher::new();
    let call_count = Arc::new(Mutex::new(0));
    let call_count_clone = Arc::clone(&call_count);

    dispatcher.on("increment", move |_| {
        *call_count_clone.lock().unwrap() += 1;
    });

    // WHEN: Dispatch same action multiple times
    let action = Action::new("increment");
    dispatcher.dispatch(&action).unwrap();
    dispatcher.dispatch(&action).unwrap();
    dispatcher.dispatch(&action).unwrap();

    // THEN: Handler called each time
    assert_eq!(*call_count.lock().unwrap(), 3);
}
