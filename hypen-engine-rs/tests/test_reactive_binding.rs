//! Additional tests for src/reactive/binding.rs
//!
//! Supplements the existing inline tests with edge cases and additional coverage

use hypen_engine::reactive::binding::{parse_binding, Binding};

// ============================================================================
// Binding Path Methods (4 tests)
// ============================================================================

#[test]
fn test_binding_root_key_simple() {
    // GIVEN: Binding with single segment
    let binding = Binding::state(vec!["user".to_string()]);

    // WHEN: Get root key
    let root = binding.root_key();

    // THEN: Returns first segment
    assert_eq!(root, Some("user"));
}

#[test]
fn test_binding_root_key_nested() {
    // GIVEN: Binding with nested path
    let binding = Binding::state(vec![
        "user".to_string(),
        "profile".to_string(),
        "name".to_string(),
    ]);

    // WHEN: Get root key
    let root = binding.root_key();

    // THEN: Returns first segment only
    assert_eq!(root, Some("user"));
}

#[test]
fn test_binding_full_path_multiple_segments() {
    // GIVEN: Binding with 4 segments
    let binding = Binding::state(vec![
        "user".to_string(),
        "profile".to_string(),
        "settings".to_string(),
        "theme".to_string(),
    ]);

    // WHEN: Get full path
    let path = binding.full_path();

    // THEN: Dot-separated string
    assert_eq!(path, "user.profile.settings.theme");
}

#[test]
fn test_binding_equality() {
    // GIVEN: Two bindings with same path
    let binding1 = Binding::state(vec!["user".to_string(), "name".to_string()]);
    let binding2 = Binding::state(vec!["user".to_string(), "name".to_string()]);
    let binding3 = Binding::state(vec!["user".to_string(), "email".to_string()]);

    // THEN: Bindings are equal if paths match
    assert_eq!(binding1, binding2);
    assert_ne!(binding1, binding3);
}

// ============================================================================
// Parsing Edge Cases (6 tests)
// ============================================================================

#[test]
fn test_parse_binding_with_whitespace() {
    // GIVEN: Binding with extra whitespace
    let binding = parse_binding("  @{state.user.name}  ");

    // WHEN/THEN: Whitespace trimmed, parses correctly
    assert!(binding.is_some());
    let b = binding.unwrap();
    assert_eq!(b.path, vec!["user", "name"]);
}

#[test]
fn test_parse_binding_with_numbers() {
    // GIVEN: Binding with numeric segments
    let binding = parse_binding("@{state.items.0.id}");

    // WHEN/THEN: Numbers treated as strings
    assert!(binding.is_some());
    let b = binding.unwrap();
    assert_eq!(b.path, vec!["items", "0", "id"]);
}

#[test]
fn test_parse_binding_with_underscores() {
    // GIVEN: Binding with underscores in keys
    let binding = parse_binding("@{state.user_profile.first_name}");

    // WHEN/THEN: Underscores preserved
    assert!(binding.is_some());
    let b = binding.unwrap();
    assert_eq!(b.path, vec!["user_profile", "first_name"]);
}

#[test]
fn test_parse_binding_missing_closing_brace() {
    // GIVEN: Malformed binding without closing brace
    let binding = parse_binding("@{state.user.name");

    // WHEN/THEN: Returns None
    assert!(binding.is_none());
}

#[test]
fn test_parse_binding_unknown_prefix_returns_none() {
    // GIVEN: Binding with a non-state/non-item prefix (e.g., "props")
    // parse_binding only recognizes state.* and item.* — data source bindings
    // use the parser's explicit @provider.path syntax, not @{provider.path}
    let binding = parse_binding("@{props.user.name}");

    // WHEN/THEN: Returns None (unknown prefix)
    assert!(binding.is_none());

    // Same for other unknown prefixes
    assert!(parse_binding("@{spacetime.messages}").is_none());
    assert!(parse_binding("@{firebase.user}").is_none());
}

#[test]
fn test_parse_binding_empty_path_after_state() {
    // GIVEN: Just "@{state}" without any path
    let binding = parse_binding("@{state}");

    // WHEN/THEN: Returns None (path required after state)
    assert!(binding.is_none());
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_binding_clone() {
    // GIVEN: Original binding
    let original = Binding::state(vec!["user".to_string(), "name".to_string()]);

    // WHEN: Clone it
    let cloned = original.clone();

    // THEN: Clone is equal but independent
    assert_eq!(original, cloned);
    assert_eq!(original.path, cloned.path);
}

#[test]
fn test_parse_binding_very_deep_nesting() {
    // GIVEN: Very deeply nested binding (10 levels)
    let deep = "@{state.a.b.c.d.e.f.g.h.i.j}";
    let binding = parse_binding(deep);

    // WHEN/THEN: Handles deep nesting
    assert!(binding.is_some());
    let b = binding.unwrap();
    assert_eq!(b.path.len(), 10);
    assert_eq!(b.root_key(), Some("a"));
}

#[test]
fn test_binding_empty_path_vec() {
    // GIVEN: Binding with empty path (edge case, shouldn't happen in practice)
    let binding = Binding::state(vec![]);

    // WHEN: Get root key and full path
    let root = binding.root_key();
    let path = binding.full_path();

    // THEN: Handles gracefully
    assert_eq!(root, None);
    assert_eq!(path, "");
}
