//! Test matchers - assertion helpers for common patterns
#![allow(dead_code)]

use hypen_engine::ir::{Element, Value};
use hypen_engine::reconcile::Patch;
use serde_json::Value as JsonValue;

// ========== Patch Matchers ==========

/// Assert that a patch is a Create patch with the given element type
pub fn assert_create_patch(patch: &Patch, expected_type: &str) {
    match patch {
        Patch::Create { element_type, .. } => {
            assert_eq!(
                element_type, expected_type,
                "Expected Create patch with type '{}', got '{}'",
                expected_type, element_type
            );
        }
        _ => panic!("Expected Create patch, got {:?}", patch),
    }
}

/// Assert that a patch is a SetProp patch with the given name
pub fn assert_set_prop_patch(patch: &Patch, expected_name: &str) {
    match patch {
        Patch::SetProp { name, .. } => {
            assert_eq!(
                name, expected_name,
                "Expected SetProp patch with name '{}', got '{}'",
                expected_name, name
            );
        }
        _ => panic!("Expected SetProp patch, got {:?}", patch),
    }
}

/// Assert that a patch is a SetProp patch with specific name and value
pub fn assert_set_prop_value(patch: &Patch, expected_name: &str, expected_value: &JsonValue) {
    match patch {
        Patch::SetProp { name, value, .. } => {
            assert_eq!(name, expected_name, "Property name mismatch");
            assert_eq!(value, expected_value, "Property value mismatch");
        }
        _ => panic!("Expected SetProp patch, got {:?}", patch),
    }
}

/// Assert that a patch is a SetText patch
pub fn assert_set_text_patch(patch: &Patch, expected_text: &str) {
    match patch {
        Patch::SetText { text, .. } => {
            assert_eq!(
                text, expected_text,
                "Expected SetText with '{}', got '{}'",
                expected_text, text
            );
        }
        _ => panic!("Expected SetText patch, got {:?}", patch),
    }
}

/// Assert that a patch is an Insert patch
pub fn assert_insert_patch(patch: &Patch) {
    match patch {
        Patch::Insert { .. } => {}
        _ => panic!("Expected Insert patch, got {:?}", patch),
    }
}

/// Assert that a patch is a Move patch
pub fn assert_move_patch(patch: &Patch) {
    match patch {
        Patch::Move { .. } => {}
        _ => panic!("Expected Move patch, got {:?}", patch),
    }
}

/// Assert that a patch is a Remove patch
pub fn assert_remove_patch(patch: &Patch) {
    match patch {
        Patch::Remove { .. } => {}
        _ => panic!("Expected Remove patch, got {:?}", patch),
    }
}

// Note: Event handling patches removed from Patch enum
// Events are now handled at the renderer level

// ========== Patch Collection Matchers ==========

/// Count patches of a specific type
pub fn count_creates(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count()
}

pub fn count_set_props(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::SetProp { .. }))
        .count()
}

pub fn count_inserts(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Insert { .. }))
        .count()
}

pub fn count_removes(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .count()
}

pub fn count_moves(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Move { .. }))
        .count()
}

/// Assert that patches contain at least one Create patch
pub fn assert_has_create(patches: &[Patch]) {
    assert!(
        count_creates(patches) > 0,
        "Expected at least one Create patch, found none"
    );
}

/// Assert that patches contain no SetProp patches (no changes)
pub fn assert_no_changes(patches: &[Patch]) {
    let set_props = count_set_props(patches);
    assert_eq!(
        set_props, 0,
        "Expected no changes (SetProp patches), found {}",
        set_props
    );
}

/// Assert patch count
pub fn assert_patch_count(patches: &[Patch], expected: usize) {
    assert_eq!(
        patches.len(),
        expected,
        "Expected {} patches, got {}",
        expected,
        patches.len()
    );
}

// ========== Element Matchers ==========

/// Assert element type
pub fn assert_element_type(element: &Element, expected_type: &str) {
    assert_eq!(
        element.element_type, expected_type,
        "Expected element type '{}', got '{}'",
        expected_type, element.element_type
    );
}

/// Assert element has a specific prop
pub fn assert_has_prop(element: &Element, prop_name: &str) {
    assert!(
        element.props.contains_key(prop_name),
        "Expected element to have prop '{}', but it doesn't",
        prop_name
    );
}

/// Assert element prop value (for Static values)
pub fn assert_prop_static_value(
    element: &Element,
    prop_name: &str,
    expected_value: &serde_json::Value,
) {
    let actual = element
        .props
        .get(prop_name)
        .unwrap_or_else(|| panic!("Element does not have prop '{}'", prop_name));
    match actual {
        Value::Static(v) => assert_eq!(v, expected_value, "Prop '{}' has wrong value", prop_name),
        _ => panic!("Prop '{}' is not a Static value", prop_name),
    }
}

/// Assert element has children
pub fn assert_has_children(element: &Element, expected_count: usize) {
    assert_eq!(
        element.ir_children.len(),
        expected_count,
        "Expected {} children, got {}",
        expected_count,
        element.ir_children.len()
    );
}

/// Assert element has a key
pub fn assert_has_key(element: &Element, expected_key: &str) {
    match &element.key {
        Some(key) => assert_eq!(key, expected_key, "Key mismatch"),
        None => panic!("Element has no key, expected '{}'", expected_key),
    }
}

// ========== Value Matchers ==========

/// Assert Value is Static
pub fn assert_static_value(value: &Value, expected: &JsonValue) {
    match value {
        Value::Static(v) => assert_eq!(v, expected, "Static value mismatch"),
        _ => panic!("Expected Static value, got {:?}", value),
    }
}

/// Assert Value is Binding
pub fn assert_binding_value(value: &Value, expected_path: &str) {
    match value {
        Value::Binding(binding) => {
            assert_eq!(binding.full_path(), expected_path, "Binding path mismatch");
        }
        _ => panic!("Expected Binding value, got {:?}", value),
    }
}

/// Assert Value is Action
pub fn assert_action_value(value: &Value, expected_action: &str) {
    match value {
        Value::Action(action) => {
            assert_eq!(action, expected_action, "Action mismatch");
        }
        _ => panic!("Expected Action value, got {:?}", value),
    }
}

// ========== JSON Matchers ==========

/// Assert JSON contains a path
pub fn assert_json_path(value: &JsonValue, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;

    for part in &parts {
        match current {
            JsonValue::Object(map) => {
                current = map
                    .get(*part)
                    .unwrap_or_else(|| panic!("JSON path '{}' not found at '{}'", path, part));
            }
            JsonValue::Array(arr) => {
                let index: usize = part
                    .parse()
                    .unwrap_or_else(|_| panic!("Expected array index, got '{}'", part));
                current = arr
                    .get(index)
                    .unwrap_or_else(|| panic!("Array index {} out of bounds", index));
            }
            _ => panic!("Cannot traverse path '{}' at '{}'", path, part),
        }
    }
}

/// Assert JSON path has specific value
pub fn assert_json_path_value(value: &JsonValue, path: &str, expected: &JsonValue) {
    assert_json_path(value, path);

    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;

    for part in &parts {
        match current {
            JsonValue::Object(map) => {
                current = map.get(*part).unwrap();
            }
            JsonValue::Array(arr) => {
                let index: usize = part.parse().unwrap();
                current = arr.get(index).unwrap();
            }
            _ => {}
        }
    }

    assert_eq!(current, expected, "JSON path '{}' value mismatch", path);
}
