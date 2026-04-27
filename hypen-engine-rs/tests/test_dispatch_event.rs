//! Tests for src/dispatch/event.rs - Event routing system
//!
//! Tests event creation, router registration, and event-action mapping

use hypen_engine::dispatch::event::{Event, EventRouter};
use serde_json::json;

// ============================================================================
// Event Creation (2 tests)
// ============================================================================

#[test]
fn test_event_new() {
    // GIVEN/WHEN: Create new event
    let event = Event::new("node123", "click");

    // THEN: Event created with node_id and event_name
    assert_eq!(event.node_id, "node123");
    assert_eq!(event.event_name, "click");
    assert!(event.payload.is_none());
}

#[test]
fn test_event_with_payload() {
    // GIVEN: Event with payload
    let event = Event::new("input456", "change").with_payload(json!({
        "value": "Hello World",
        "timestamp": 1234567890
    }));

    // THEN: Payload attached
    assert_eq!(event.node_id, "input456");
    assert_eq!(event.event_name, "change");
    assert!(event.payload.is_some());
    let payload = event.payload.as_ref().unwrap();
    assert_eq!(payload["value"], "Hello World");
    assert_eq!(payload["timestamp"], 1234567890);
}

// ============================================================================
// Event Router Registration (4 tests)
// ============================================================================

#[test]
fn test_router_register_event_action_mapping() {
    // GIVEN: EventRouter
    let mut router = EventRouter::new();

    // WHEN: Register event-action mapping
    router.register("button1", "click", "increment");

    // THEN: Mapping exists
    let action = router.get_action("button1", "click");
    assert!(action.is_some());
    assert_eq!(action.unwrap(), "increment");
}

#[test]
fn test_router_multiple_event_registrations() {
    // GIVEN: EventRouter
    let mut router = EventRouter::new();

    // WHEN: Register multiple event-action mappings
    router.register("button1", "click", "increment");
    router.register("button2", "click", "decrement");
    router.register("input1", "change", "updateText");

    // THEN: All mappings exist
    assert_eq!(router.get_action("button1", "click"), Some("increment"));
    assert_eq!(router.get_action("button2", "click"), Some("decrement"));
    assert_eq!(router.get_action("input1", "change"), Some("updateText"));
}

#[test]
fn test_router_unregister_event() {
    // GIVEN: Router with registered event
    let mut router = EventRouter::new();
    router.register("node1", "click", "action1");
    assert!(router.get_action("node1", "click").is_some());

    // WHEN: Unregister event
    router.unregister("node1", "click");

    // THEN: Mapping removed
    assert!(router.get_action("node1", "click").is_none());
}

#[test]
fn test_router_clear_all_mappings() {
    // GIVEN: Router with multiple mappings
    let mut router = EventRouter::new();
    router.register("node1", "click", "action1");
    router.register("node2", "submit", "action2");
    router.register("node3", "change", "action3");

    // WHEN: Clear all
    router.clear();

    // THEN: All mappings removed
    assert!(router.get_action("node1", "click").is_none());
    assert!(router.get_action("node2", "submit").is_none());
    assert!(router.get_action("node3", "change").is_none());
}

// ============================================================================
// Event-Action Mapping (4 tests)
// ============================================================================

#[test]
fn test_same_node_multiple_events() {
    // GIVEN: Router
    let mut router = EventRouter::new();

    // WHEN: Register same node with different events
    router.register("button1", "click", "handleClick");
    router.register("button1", "dblclick", "handleDoubleClick");
    router.register("button1", "mouseenter", "handleHover");

    // THEN: Each event maps to different action
    assert_eq!(router.get_action("button1", "click"), Some("handleClick"));
    assert_eq!(
        router.get_action("button1", "dblclick"),
        Some("handleDoubleClick")
    );
    assert_eq!(
        router.get_action("button1", "mouseenter"),
        Some("handleHover")
    );
}

#[test]
fn test_same_event_different_nodes() {
    // GIVEN: Router
    let mut router = EventRouter::new();

    // WHEN: Register same event name on different nodes
    router.register("button1", "click", "action1");
    router.register("button2", "click", "action2");
    router.register("button3", "click", "action3");

    // THEN: Each node maps to different action
    assert_eq!(router.get_action("button1", "click"), Some("action1"));
    assert_eq!(router.get_action("button2", "click"), Some("action2"));
    assert_eq!(router.get_action("button3", "click"), Some("action3"));
}

#[test]
fn test_get_action_for_unregistered_event() {
    // GIVEN: Router with some mappings
    let mut router = EventRouter::new();
    router.register("node1", "click", "action1");

    // WHEN: Query unregistered event
    let action = router.get_action("node2", "click");

    // THEN: Returns None
    assert!(action.is_none());
}

#[test]
fn test_register_overwrites_existing_mapping() {
    // GIVEN: Router with registered mapping
    let mut router = EventRouter::new();
    router.register("node1", "click", "oldAction");
    assert_eq!(router.get_action("node1", "click"), Some("oldAction"));

    // WHEN: Register same event with different action
    router.register("node1", "click", "newAction");

    // THEN: Mapping overwritten
    assert_eq!(router.get_action("node1", "click"), Some("newAction"));
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_router_default() {
    // GIVEN/WHEN: Create using default
    let router = EventRouter::default();

    // THEN: Same as new() (no mappings)
    assert!(router.get_action("any", "event").is_none());
}

#[test]
fn test_event_serialization() {
    // GIVEN: Event with all fields
    let event = Event::new("node789", "submit").with_payload(json!({"formData": "test"}));

    // WHEN: Serialize to JSON
    let json_str = serde_json::to_string(&event).unwrap();

    // THEN: All fields serialized
    assert!(json_str.contains("node789"));
    assert!(json_str.contains("submit"));
    assert!(json_str.contains("formData"));
}

#[test]
fn test_event_deserialization() {
    // GIVEN: JSON representation
    let json_str = r#"{
        "node_id": "node123",
        "event_name": "click",
        "payload": {"x": 100, "y": 200}
    }"#;

    // WHEN: Deserialize from JSON
    let event: Event = serde_json::from_str(json_str).unwrap();

    // THEN: All fields deserialized correctly
    assert_eq!(event.node_id, "node123");
    assert_eq!(event.event_name, "click");
    let payload = event.payload.as_ref().unwrap();
    assert_eq!(payload["x"], 100);
    assert_eq!(payload["y"], 200);
}

#[test]
fn test_unregister_nonexistent_event_no_panic() {
    // GIVEN: Empty router
    let mut router = EventRouter::new();

    // WHEN: Unregister nonexistent event
    router.unregister("nonexistent", "click");

    // THEN: No panic (operation is safe)
    assert!(router.get_action("nonexistent", "click").is_none());
}

#[test]
fn test_event_with_complex_payload() {
    // GIVEN: Event with nested payload
    let event = Event::new("form1", "submit").with_payload(json!({
        "user": {
            "name": "Alice",
            "email": "alice@example.com"
        },
        "preferences": ["dark_mode", "notifications"],
        "timestamp": 1234567890
    }));

    // THEN: Complex payload preserved
    let payload = event.payload.as_ref().unwrap();
    assert_eq!(payload["user"]["name"], "Alice");
    assert_eq!(payload["user"]["email"], "alice@example.com");
    assert_eq!(payload["preferences"][0], "dark_mode");
    assert_eq!(payload["timestamp"], 1234567890);
}

#[test]
fn test_router_get_action_with_special_characters() {
    // GIVEN: Router with special character node IDs
    let mut router = EventRouter::new();
    router.register("node-123", "click", "action1");
    router.register("node_456", "submit", "action2");
    router.register("node.789", "change", "action3");

    // THEN: Special characters handled correctly
    assert_eq!(router.get_action("node-123", "click"), Some("action1"));
    assert_eq!(router.get_action("node_456", "submit"), Some("action2"));
    assert_eq!(router.get_action("node.789", "change"), Some("action3"));
}
