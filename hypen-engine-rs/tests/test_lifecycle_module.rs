//! Tests for src/lifecycle/module.rs - Module lifecycle and state management
//!
//! Tests module creation, mounting/unmounting, and state merging

use hypen_engine::lifecycle::{Module, ModuleInstance};
use serde_json::json;

// ============================================================================
// Module/ModuleInstance Creation (4 tests)
// ============================================================================

#[test]
fn test_module_new() {
    // GIVEN/WHEN: Create new module
    let module = Module::new("UserProfile");

    // THEN: Default values set
    assert_eq!(module.name, "UserProfile");
    assert_eq!(module.actions.len(), 0);
    assert_eq!(module.state_keys.len(), 0);
    assert!(!module.persist);
    assert_eq!(module.version, None);
}

#[test]
fn test_module_builder_pattern() {
    // GIVEN/WHEN: Build module with fluent API
    let module = Module::new("Counter")
        .with_actions(vec!["increment".to_string(), "decrement".to_string()])
        .with_state_keys(vec!["count".to_string()])
        .with_persist(true)
        .with_version(1);

    // THEN: All properties set correctly
    assert_eq!(module.name, "Counter");
    assert_eq!(module.actions, vec!["increment", "decrement"]);
    assert_eq!(module.state_keys, vec!["count"]);
    assert!(module.persist);
    assert_eq!(module.version, Some(1));
}

#[test]
fn test_module_instance_new() {
    // GIVEN: Module and initial state
    let module = Module::new("User");
    let state = json!({
        "name": "Alice",
        "email": "alice@example.com"
    });

    // WHEN: Create module instance
    let instance = ModuleInstance::new(module, state.clone());

    // THEN: Instance initialized correctly
    assert_eq!(instance.module.name, "User");
    assert_eq!(instance.get_state(), &state);
    assert!(!instance.mounted);
}

#[test]
fn test_module_instance_with_empty_state() {
    // GIVEN: Module with empty state
    let module = Module::new("Empty");
    let state = json!({});

    // WHEN: Create module instance
    let instance = ModuleInstance::new(module, state);

    // THEN: Empty state accepted
    assert_eq!(instance.get_state(), &json!({}));
    assert!(!instance.mounted);
}

// ============================================================================
// State Merging Scenarios (6 tests)
// ============================================================================

#[test]
fn test_update_state_simple_merge() {
    // GIVEN: Module instance with initial state
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "name": "Alice",
            "age": 30
        }),
    );

    // WHEN: Update age
    instance.update_state(json!({
        "age": 31
    }));

    // THEN: Age updated, name preserved
    assert_eq!(instance.get_state()["name"], "Alice");
    assert_eq!(instance.get_state()["age"], 31);
}

#[test]
fn test_update_state_nested_merge() {
    // GIVEN: Module instance with nested state
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "user": {
                "profile": {
                    "name": "Alice",
                    "bio": "Developer"
                },
                "email": "alice@example.com"
            }
        }),
    );

    // WHEN: Update nested bio
    instance.update_state(json!({
        "user": {
            "profile": {
                "bio": "Senior Developer"
            }
        }
    }));

    // THEN: Bio updated, other fields preserved
    assert_eq!(instance.get_state()["user"]["profile"]["name"], "Alice");
    assert_eq!(
        instance.get_state()["user"]["profile"]["bio"],
        "Senior Developer"
    );
    assert_eq!(instance.get_state()["user"]["email"], "alice@example.com");
}

#[test]
fn test_update_state_add_new_keys() {
    // GIVEN: Module instance with some state
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "name": "Alice"
        }),
    );

    // WHEN: Add new keys via patch
    instance.update_state(json!({
        "age": 30,
        "email": "alice@example.com"
    }));

    // THEN: New keys added, existing preserved
    assert_eq!(instance.get_state()["name"], "Alice");
    assert_eq!(instance.get_state()["age"], 30);
    assert_eq!(instance.get_state()["email"], "alice@example.com");
}

#[test]
fn test_update_state_replace_non_object_value() {
    // GIVEN: Module instance with a number
    let module = Module::new("Counter");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "count": 10
        }),
    );

    // WHEN: Update count (non-object, so it replaces)
    instance.update_state(json!({
        "count": 15
    }));

    // THEN: Count replaced
    assert_eq!(instance.get_state()["count"], 15);
}

#[test]
fn test_update_state_replace_object_with_primitive() {
    // GIVEN: Module instance with nested object
    let module = Module::new("Data");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        }),
    );

    // WHEN: Replace entire "user" with primitive
    instance.update_state(json!({
        "user": "Alice"
    }));

    // THEN: Object replaced with primitive
    assert_eq!(instance.get_state()["user"], "Alice");
}

#[test]
fn test_update_state_deep_nesting() {
    // GIVEN: Module instance with deeply nested state
    let module = Module::new("Deep");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "a": {
                "b": {
                    "c": {
                        "d": {
                            "value": 1
                        }
                    }
                }
            }
        }),
    );

    // WHEN: Update deeply nested value
    instance.update_state(json!({
        "a": {
            "b": {
                "c": {
                    "d": {
                        "value": 2
                    }
                }
            }
        }
    }));

    // THEN: Deeply nested value updated
    assert_eq!(instance.get_state()["a"]["b"]["c"]["d"]["value"], 2);
}

// ============================================================================
// Lifecycle Events (Mount/Unmount) (5 tests)
// ============================================================================

#[test]
fn test_mount_changes_mounted_flag() {
    // GIVEN: Unmounted module instance
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(module, json!({}));
    assert!(!instance.mounted);

    // WHEN: Mount module
    instance.mount();

    // THEN: Mounted flag set
    assert!(instance.mounted);
}

#[test]
fn test_unmount_changes_mounted_flag() {
    // GIVEN: Mounted module instance
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(module, json!({}));
    instance.mount();
    assert!(instance.mounted);

    // WHEN: Unmount module
    instance.unmount();

    // THEN: Mounted flag cleared
    assert!(!instance.mounted);
}

#[test]
fn test_mount_twice_is_idempotent() {
    // GIVEN: Module instance
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(module, json!({}));

    // WHEN: Mount twice
    instance.mount();
    instance.mount();

    // THEN: Still mounted once
    assert!(instance.mounted);
}

#[test]
fn test_unmount_twice_is_idempotent() {
    // GIVEN: Mounted module instance
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(module, json!({}));
    instance.mount();

    // WHEN: Unmount twice
    instance.unmount();
    instance.unmount();

    // THEN: Still unmounted
    assert!(!instance.mounted);
}

#[test]
fn test_get_state_returns_current_state() {
    // GIVEN: Module instance with state
    let module = Module::new("User");
    let initial_state = json!({
        "name": "Alice",
        "age": 30
    });
    let instance = ModuleInstance::new(module, initial_state.clone());

    // WHEN: Get state
    let state = instance.get_state();

    // THEN: Returns reference to current state
    assert_eq!(state, &initial_state);
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_module_serialization() {
    // GIVEN: Module with all fields set
    let module = Module::new("Counter")
        .with_actions(vec!["increment".to_string()])
        .with_state_keys(vec!["count".to_string()])
        .with_persist(true)
        .with_version(2);

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&module).unwrap();

    // THEN: All fields serialized
    assert_eq!(json["name"], "Counter");
    assert_eq!(json["actions"], json!(["increment"]));
    assert_eq!(json["state_keys"], json!(["count"]));
    assert_eq!(json["persist"], true);
    assert_eq!(json["version"], 2);
}

#[test]
fn test_module_deserialization() {
    // GIVEN: JSON representation
    let json = json!({
        "name": "UserProfile",
        "actions": ["updateName", "updateEmail"],
        "state_keys": ["user"],
        "persist": false,
        "version": null
    });

    // WHEN: Deserialize from JSON
    let module: Module = serde_json::from_value(json).unwrap();

    // THEN: Module created correctly
    assert_eq!(module.name, "UserProfile");
    assert_eq!(module.actions, vec!["updateName", "updateEmail"]);
    assert_eq!(module.state_keys, vec!["user"]);
    assert!(!module.persist);
    assert_eq!(module.version, None);
}

#[test]
fn test_update_state_preserves_reference() {
    // GIVEN: Module instance
    let module = Module::new("User");
    let mut instance = ModuleInstance::new(
        module,
        json!({
            "count": 0
        }),
    );

    // WHEN: Update state multiple times
    instance.update_state(json!({"count": 1}));
    instance.update_state(json!({"count": 2}));
    instance.update_state(json!({"count": 3}));

    // THEN: Final value correct
    assert_eq!(instance.get_state()["count"], 3);
}
