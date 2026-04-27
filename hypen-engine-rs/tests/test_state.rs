//! Tests for src/state.rs - State change tracking
//!
//! Tests path-based state change notifications

use hypen_engine::state::StateChange;
use serde_json::json;

// ============================================================================
// Path Extraction from JSON Patches (6 tests)
// ============================================================================

#[test]
fn test_extract_paths_from_simple_object() {
    // GIVEN: Simple flat object
    let patch = json!({
        "name": "Alice",
        "age": 30
    });

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: Both paths extracted
    assert!(change.contains("name"));
    assert!(change.contains("age"));
    assert_eq!(change.changed_paths.len(), 2);
}

#[test]
fn test_extract_paths_from_nested_object() {
    // GIVEN: Nested object
    let patch = json!({
        "user": {
            "profile": {
                "name": "Alice",
                "bio": "Developer"
            },
            "email": "alice@example.com"
        }
    });

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: All nested paths extracted (including parent paths)
    assert!(change.contains("user"));
    assert!(change.contains("user.profile"));
    assert!(change.contains("user.profile.name"));
    assert!(change.contains("user.profile.bio"));
    assert!(change.contains("user.email"));
}

#[test]
fn test_extract_paths_from_mixed_types() {
    // GIVEN: Object with various value types
    let patch = json!({
        "string": "text",
        "number": 42,
        "boolean": true,
        "null": null,
        "array": [1, 2, 3],
        "object": {"nested": "value"}
    });

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: Paths extracted for all types
    assert!(change.contains("string"));
    assert!(change.contains("number"));
    assert!(change.contains("boolean"));
    assert!(change.contains("null"));
    assert!(change.contains("array"));
    assert!(change.contains("object"));
    assert!(change.contains("object.nested"));
}

#[test]
fn test_extract_paths_from_empty_object() {
    // GIVEN: Empty object
    let patch = json!({});

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: No paths extracted
    assert_eq!(change.changed_paths.len(), 0);
}

#[test]
fn test_extract_paths_deeply_nested() {
    // GIVEN: Very deeply nested object (5 levels)
    let patch = json!({
        "a": {
            "b": {
                "c": {
                    "d": {
                        "e": "value"
                    }
                }
            }
        }
    });

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: All intermediate and leaf paths extracted
    assert!(change.contains("a"));
    assert!(change.contains("a.b"));
    assert!(change.contains("a.b.c"));
    assert!(change.contains("a.b.c.d"));
    assert!(change.contains("a.b.c.d.e"));
}

#[test]
fn test_extract_paths_from_primitive_value() {
    // GIVEN: Primitive value (not an object)
    let patch = json!(42);

    // WHEN: Extract paths
    let change = StateChange::from_json(&patch);

    // THEN: No paths (empty prefix for non-object root)
    assert_eq!(change.changed_paths.len(), 0);
}

// ============================================================================
// StateChange Construction from Various Sources (5 tests)
// ============================================================================

#[test]
fn test_state_change_new() {
    // GIVEN/WHEN: Create empty StateChange
    let change = StateChange::new();

    // THEN: Empty
    assert_eq!(change.changed_paths.len(), 0);
}

#[test]
fn test_state_change_default() {
    // GIVEN/WHEN: Default constructor
    let change = StateChange::default();

    // THEN: Same as new()
    assert_eq!(change.changed_paths.len(), 0);
}

#[test]
fn test_state_change_from_paths_vec() {
    // GIVEN: Vector of path strings
    let paths = vec![
        "user.name".to_string(),
        "user.email".to_string(),
        "count".to_string(),
    ];

    // WHEN: Create from paths
    let change = StateChange::from_paths(paths);

    // THEN: All paths present
    assert_eq!(change.changed_paths.len(), 3);
    assert!(change.contains("user.name"));
    assert!(change.contains("user.email"));
    assert!(change.contains("count"));
}

#[test]
fn test_state_change_add_path() {
    // GIVEN: Empty StateChange
    let mut change = StateChange::new();

    // WHEN: Add paths manually
    change.add_path("user.name");
    change.add_path("count");

    // THEN: Paths tracked
    assert_eq!(change.changed_paths.len(), 2);
    assert!(change.contains("user.name"));
    assert!(change.contains("count"));
}

#[test]
fn test_state_change_add_path_deduplication() {
    // GIVEN: StateChange
    let mut change = StateChange::new();

    // WHEN: Add same path twice
    change.add_path("user.name");
    change.add_path("user.name");

    // THEN: Only stored once (IndexSet deduplicates)
    assert_eq!(change.changed_paths.len(), 1);
    assert!(change.contains("user.name"));
}

// ============================================================================
// Prefix Matching Edge Cases (4 tests)
// ============================================================================

#[test]
fn test_has_prefix_exact_match() {
    // GIVEN: StateChange with "user.name"
    let mut change = StateChange::new();
    change.add_path("user.name");

    // WHEN: Check exact match prefix
    let has_prefix = change.has_prefix("user.name");

    // THEN: Exact match counts as prefix
    assert!(has_prefix);
}

#[test]
fn test_has_prefix_parent_path() {
    // GIVEN: StateChange with nested paths
    let mut change = StateChange::new();
    change.add_path("user.profile.name");
    change.add_path("user.email");

    // WHEN: Check parent prefix "user"
    let has_user = change.has_prefix("user");

    // THEN: Parent prefix matches children
    assert!(has_user);
}

#[test]
fn test_has_prefix_partial_name_no_match() {
    // GIVEN: StateChange with "user"
    let mut change = StateChange::new();
    change.add_path("user");

    // WHEN: Check similar but different prefix "use"
    let has_use = change.has_prefix("use");

    // THEN: Partial name doesn't match (requires exact segment)
    assert!(!has_use);
}

#[test]
fn test_has_prefix_similar_names_no_match() {
    // GIVEN: StateChange with "user" and "username"
    let mut change = StateChange::new();
    change.add_path("user");
    change.add_path("username");

    // WHEN: Check prefix "user"
    let has_user = change.has_prefix("user");

    // THEN: "user" matches itself but not "username" (not a child path)
    assert!(has_user);

    // WHEN: Check prefix "username"
    let has_username = change.has_prefix("username");

    // THEN: "username" matches itself
    assert!(has_username);
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_paths_iterator() {
    // GIVEN: StateChange with multiple paths
    let paths = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let change = StateChange::from_paths(paths);

    // WHEN: Iterate over paths
    let collected: Vec<&str> = change.paths().collect();

    // THEN: All paths accessible via iterator
    assert_eq!(collected.len(), 3);
    assert!(collected.contains(&"a"));
    assert!(collected.contains(&"b"));
    assert!(collected.contains(&"c"));
}

#[test]
fn test_contains_nonexistent_path() {
    // GIVEN: StateChange with some paths
    let mut change = StateChange::new();
    change.add_path("user.name");

    // WHEN: Check nonexistent path
    let contains = change.contains("settings");

    // THEN: Returns false
    assert!(!contains);
}
