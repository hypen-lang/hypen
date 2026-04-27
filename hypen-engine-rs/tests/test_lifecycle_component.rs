//! Tests for src/lifecycle/component.rs - Component lifecycle callbacks
//!
//! Tests lifecycle event notifications and callback registration

use hypen_engine::ir::NodeId;
use hypen_engine::lifecycle::component::{ComponentLifecycle, ComponentLifecycleEvent};
use std::sync::{Arc, Mutex};

// Helper to create test NodeId
fn test_node_id() -> NodeId {
    NodeId::default()
}

// ============================================================================
// Component Lifecycle Callbacks (5 tests)
// ============================================================================

#[test]
fn test_lifecycle_new() {
    // GIVEN/WHEN: Create new ComponentLifecycle
    let lifecycle = ComponentLifecycle::new();

    // WHEN: Notify without callback
    let node_id = test_node_id();
    lifecycle.notify_mounted(node_id);
    lifecycle.notify_unmounted(node_id);

    // THEN: No panic (callback is optional)
}

#[test]
fn test_notify_mounted_calls_callback() {
    // GIVEN: ComponentLifecycle with callback
    let mut lifecycle = ComponentLifecycle::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);

    lifecycle.on(move |node_id, event| {
        events_clone.lock().unwrap().push((node_id, event));
    });

    // WHEN: Notify mounted
    let node_id = test_node_id();
    lifecycle.notify_mounted(node_id);

    // THEN: Callback called with Mounted event
    let captured_events = events.lock().unwrap();
    assert_eq!(captured_events.len(), 1);
    assert_eq!(captured_events[0].1, ComponentLifecycleEvent::Mounted);
}

#[test]
fn test_notify_unmounted_calls_callback() {
    // GIVEN: ComponentLifecycle with callback
    let mut lifecycle = ComponentLifecycle::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);

    lifecycle.on(move |node_id, event| {
        events_clone.lock().unwrap().push((node_id, event));
    });

    // WHEN: Notify unmounted
    let node_id = test_node_id();
    lifecycle.notify_unmounted(node_id);

    // THEN: Callback called with Unmounted event
    let captured_events = events.lock().unwrap();
    assert_eq!(captured_events.len(), 1);
    assert_eq!(captured_events[0].1, ComponentLifecycleEvent::Unmounted);
}

#[test]
fn test_lifecycle_events_sequence() {
    // GIVEN: ComponentLifecycle with callback tracking sequence
    let mut lifecycle = ComponentLifecycle::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);

    lifecycle.on(move |_node_id, event| {
        events_clone.lock().unwrap().push(event);
    });

    let node_id = test_node_id();

    // WHEN: Notify mounted then unmounted
    lifecycle.notify_mounted(node_id);
    lifecycle.notify_unmounted(node_id);

    // THEN: Events in correct order
    let captured_events = events.lock().unwrap();
    assert_eq!(captured_events.len(), 2);
    assert_eq!(captured_events[0], ComponentLifecycleEvent::Mounted);
    assert_eq!(captured_events[1], ComponentLifecycleEvent::Unmounted);
}

#[test]
fn test_lifecycle_default() {
    // GIVEN/WHEN: Create using default
    let lifecycle = ComponentLifecycle::default();

    // WHEN: Notify without callback
    let node_id = test_node_id();
    lifecycle.notify_mounted(node_id);

    // THEN: Works like new() (no panic)
}

// ============================================================================
// Multiple Callback Registration (5 tests)
// ============================================================================

#[test]
fn test_callback_registration_replaces_previous() {
    // GIVEN: ComponentLifecycle
    let mut lifecycle = ComponentLifecycle::new();
    let first_called = Arc::new(Mutex::new(false));
    let second_called = Arc::new(Mutex::new(false));

    let first_clone = Arc::clone(&first_called);
    lifecycle.on(move |_node_id, _event| {
        *first_clone.lock().unwrap() = true;
    });

    // WHEN: Register second callback (replaces first)
    let second_clone = Arc::clone(&second_called);
    lifecycle.on(move |_node_id, _event| {
        *second_clone.lock().unwrap() = true;
    });

    let node_id = test_node_id();
    lifecycle.notify_mounted(node_id);

    // THEN: Only second callback called
    assert!(!(*first_called.lock().unwrap()));
    assert!(*second_called.lock().unwrap());
}

#[test]
fn test_callback_receives_correct_node_id() {
    // GIVEN: ComponentLifecycle with callback
    let mut lifecycle = ComponentLifecycle::new();
    let captured_id = Arc::new(Mutex::new(None));
    let captured_id_clone = Arc::clone(&captured_id);

    lifecycle.on(move |node_id, _event| {
        *captured_id_clone.lock().unwrap() = Some(node_id);
    });

    // WHEN: Notify with specific NodeId
    let node_id = test_node_id();
    lifecycle.notify_mounted(node_id);

    // THEN: Callback receives same NodeId
    let received_id = captured_id.lock().unwrap().unwrap();
    // NodeIds should be equal (both are default for this test)
    assert_eq!(format!("{:?}", received_id), format!("{:?}", node_id));
}

#[test]
fn test_callback_with_multiple_nodes() {
    // GIVEN: ComponentLifecycle with callback tracking all nodes
    let mut lifecycle = ComponentLifecycle::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);

    lifecycle.on(move |node_id, event| {
        events_clone.lock().unwrap().push((node_id, event));
    });

    // WHEN: Notify for multiple different nodes
    let node1 = test_node_id();
    let node2 = test_node_id();
    let node3 = test_node_id();

    lifecycle.notify_mounted(node1);
    lifecycle.notify_mounted(node2);
    lifecycle.notify_unmounted(node1);
    lifecycle.notify_mounted(node3);

    // THEN: All events captured
    let captured_events = events.lock().unwrap();
    assert_eq!(captured_events.len(), 4);
    assert_eq!(captured_events[0].1, ComponentLifecycleEvent::Mounted);
    assert_eq!(captured_events[1].1, ComponentLifecycleEvent::Mounted);
    assert_eq!(captured_events[2].1, ComponentLifecycleEvent::Unmounted);
    assert_eq!(captured_events[3].1, ComponentLifecycleEvent::Mounted);
}

#[test]
fn test_callback_can_be_stateful() {
    // GIVEN: ComponentLifecycle with stateful callback (counter)
    let mut lifecycle = ComponentLifecycle::new();
    let mount_count = Arc::new(Mutex::new(0));
    let unmount_count = Arc::new(Mutex::new(0));

    let mount_clone = Arc::clone(&mount_count);
    let unmount_clone = Arc::clone(&unmount_count);

    lifecycle.on(move |_node_id, event| match event {
        ComponentLifecycleEvent::Mounted => {
            *mount_clone.lock().unwrap() += 1;
        }
        ComponentLifecycleEvent::Unmounted => {
            *unmount_clone.lock().unwrap() += 1;
        }
    });

    let node_id = test_node_id();

    // WHEN: Multiple mount/unmount cycles
    lifecycle.notify_mounted(node_id);
    lifecycle.notify_unmounted(node_id);
    lifecycle.notify_mounted(node_id);
    lifecycle.notify_unmounted(node_id);
    lifecycle.notify_mounted(node_id);

    // THEN: Counts correct
    assert_eq!(*mount_count.lock().unwrap(), 3);
    assert_eq!(*unmount_count.lock().unwrap(), 2);
}

#[test]
fn test_callback_without_registration_does_nothing() {
    // GIVEN: ComponentLifecycle without callback
    let lifecycle = ComponentLifecycle::new();
    let node_id = test_node_id();

    // WHEN: Notify events
    lifecycle.notify_mounted(node_id);
    lifecycle.notify_unmounted(node_id);

    // THEN: No panic, no side effects
    // Test passes if no panic occurs
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_lifecycle_event_equality() {
    // GIVEN: ComponentLifecycleEvent variants
    let mounted1 = ComponentLifecycleEvent::Mounted;
    let mounted2 = ComponentLifecycleEvent::Mounted;
    let unmounted = ComponentLifecycleEvent::Unmounted;

    // THEN: Equality works correctly
    assert_eq!(mounted1, mounted2);
    assert_ne!(mounted1, unmounted);
}

#[test]
fn test_lifecycle_event_clone() {
    // GIVEN: ComponentLifecycleEvent
    let event = ComponentLifecycleEvent::Mounted;

    // WHEN: Clone it
    let cloned = event;

    // THEN: Clone is equal
    assert_eq!(event, cloned);
}

#[test]
fn test_lifecycle_event_copy() {
    // GIVEN: ComponentLifecycleEvent
    let event = ComponentLifecycleEvent::Unmounted;

    // WHEN: Copy it (via assignment)
    let copied = event;

    // THEN: Copy is equal and original still usable
    assert_eq!(event, copied);
    assert_eq!(event, ComponentLifecycleEvent::Unmounted);
}
