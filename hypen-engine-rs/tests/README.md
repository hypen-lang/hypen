# Hypen Engine Test Utilities

This directory contains common test utilities for writing tests across the hypen-engine codebase.

## Overview

The `common/` module provides three main categories of utilities:

1. **Fixtures** (`fixtures.rs`) - Pre-built elements, components, modules, and test data
2. **Matchers** (`matchers.rs`) - Assertion helpers for common patterns
3. **Helpers** (`helpers.rs`) - Utility functions for tree traversal, paths, and debugging

## Quick Start

```rust
// In your test file
mod common;
use common::*;

#[test]
fn test_example() {
    // GIVEN: Create test elements using fixtures
    let element = column_with_children(vec![
        text_element("Hello"),
        text_element("World"),
    ]);

    // THEN: Use matchers to assert properties
    assert_element_type(&element, "Column");
    assert_has_children(&element, 2);
}
```

## Fixtures

### Element Fixtures

Create common element types with ease:

```rust
// Basic elements
let text = text_element("Hello");
let img = image_element("https://example.com/image.jpg");
let btn = button_element("Click me");

// Elements with state bindings
let dynamic_text = text_element_with_binding("user.name");
// Renders as: Text { text: @{state.user.name} }

// Containers
let column = column_with_children(vec![
    text_element("First"),
    text_element("Second"),
]);

// Elements with actions
let action_btn = button_with_action("Submit", "submitForm");

// Keyed elements (for reconciliation)
let keyed = keyed_text_element("Item 1", "item-1");
```

### Tree Fixtures

Create complex tree structures for testing:

```rust
// Nested tree: Column { Text("A"), Row { Text("B"), Text("C") }, Text("D") }
let nested = nested_tree();

// Deep tree (for performance testing)
let deep = deep_tree(100); // 100 levels deep

// Wide tree (for stress testing)
let wide = wide_tree(1000); // 1000 children

// Keyed list
let items = keyed_list(&["Item 1", "Item 2", "Item 3"]);
```

### Component Fixtures

```rust
// Simple component that always renders the same content
let comp = simple_component("Button", "Click me");

// Component that uses props
let comp = component_with_prop("Greeting", "name");

// Container component
let comp = container_component("Card");
```

### Module Fixtures

```rust
// Simple module
let module = simple_module("ProfilePage");

// Module with initial state
let module = module_instance_with_state("UserModule", json!({
    "user": {"name": "Alice"}
}));

// Pre-built modules with common state patterns
let user_mod = user_module();
let counter_mod = counter_module();
let list_mod = list_module();
```

### State Fixtures

```rust
// Common state patterns
let state = user_state();  // { user: { id, name, email, profile: {...} } }
let state = cart_state();  // { cart: { items: [...], total: 45.0 } }
let state = form_state();  // { form: { name, email, message, errors } }
```

### Callback Fixtures

```rust
// Capture patches for assertion
let (patches, callback) = patch_capture();
engine.set_render_callback(callback);
// ... render something ...
let captured = patches.lock().unwrap();
assert_eq!(captured.len(), 5);

// Count function calls
let (count, callback) = call_counter();
// ... use callback ...
assert_eq!(*count.lock().unwrap(), 3);
```

## Matchers

### Patch Matchers

```rust
// Assert specific patch types
assert_create_patch(&patch, "Text");
assert_set_prop_patch(&patch, "color");
assert_set_prop_value(&patch, "color", &json!("red"));
assert_set_text_patch(&patch, "Hello");
assert_insert_patch(&patch);
assert_move_patch(&patch);
assert_remove_patch(&patch);

// Count patches by type
let creates = count_creates(&patches);
let set_props = count_set_props(&patches);
let inserts = count_inserts(&patches);
let removes = count_removes(&patches);
let moves = count_moves(&patches);

// Collection assertions
assert_has_create(&patches);  // At least one Create patch
assert_no_changes(&patches);  // No SetProp patches
assert_patch_count(&patches, 10);  // Exactly 10 patches
```

### Element Matchers

```rust
// Element structure
assert_element_type(&element, "Column");
assert_has_children(&element, 3);
assert_has_key(&element, "item-1");

// Props
assert_has_prop(&element, "color");
assert_prop_static_value(&element, "text", &json!("Hello"));
```

### Value Matchers

```rust
// Value type assertions
assert_static_value(&value, &json!("Hello"));
assert_binding_value(&value, "user.name");
assert_action_value(&value, "submitForm");
```

### JSON Matchers

```rust
// JSON path assertions
assert_json_path(&value, "user.profile.avatar");
assert_json_path_value(&value, "user.name", &json!("Alice"));
```

## Helpers

### Tree Helpers

```rust
// Count nodes in a tree
let count = count_tree_nodes(&tree);

// Get all node IDs
let ids = collect_node_ids(&tree);

// Get tree depth
let depth = tree_depth(&tree);

// Find node by type
if let Some(node_id) = find_node_by_type(&tree, "Button") {
    // ...
}
```

### Path Helpers

```rust
// Split paths
let parts = split_path("user.profile.name");  // ["user", "profile", "name"]

// Check path prefix
assert!(is_path_prefix("user", "user.name"));

// Get parent path
let parent = parent_path("user.profile.name");  // Some("user.profile")
```

### Timing Helpers

```rust
// Measure execution time
let (result, duration) = measure_time(|| {
    engine.render(&element);
});

// Assert completion within time limit
let result = assert_completes_within(Duration::from_millis(100), || {
    reconcile_large_tree();
});
```

### Debug Helpers

```rust
// Print tree structure (for debugging)
print_tree(&tree);
// Output:
//   Column (id: NodeId(...), key: None)
//     Text (id: NodeId(...), key: None)
//     Text (id: NodeId(...), key: None)

// Print patches (for debugging)
print_patches(&patches);
// Output:
//   Patches (3):
//     [0] Create { element_type: "Column", ... }
//     [1] Create { element_type: "Text", ... }
//     [2] Insert { parent_id: "...", ... }

// Tree snapshot for comparison
let snapshot = tree_snapshot(&tree);
```

## Writing Tests with Given/When/Then

All tests should follow the Given/When/Then pattern:

```rust
#[test]
fn test_feature_name() {
    // GIVEN: Setup initial state
    let mut engine = Engine::new();
    let element = text_element("Hello");
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Perform action
    engine.render(&element);

    // THEN: Verify expectations
    let captured = patches.lock().unwrap();
    assert_has_create(&captured);
    assert_patch_count(&captured, 2);  // Create + Insert
}
```

## Examples

See `tests/test_common.rs` for working examples of all utilities.

### Example: Testing Element Creation

```rust
#[test]
fn test_column_with_children() {
    // GIVEN: Create a column with two text elements
    let element = column_with_children(vec![
        text_element("First"),
        text_element("Second"),
    ]);

    // THEN: It has the correct structure
    assert_element_type(&element, "Column");
    assert_has_children(&element, 2);
    assert_element_type(&element.children[0], "Text");
    assert_element_type(&element.children[1], "Text");
}
```

### Example: Testing State Bindings

```rust
#[test]
fn test_state_binding_resolution() {
    // GIVEN: Element with binding and module with state
    let element = text_element_with_binding("user.name");
    let module = module_instance_with_state("UserModule", json!({
        "user": {"name": "Alice"}
    }));

    // WHEN: Render with state
    let mut engine = Engine::new();
    engine.set_module(module);
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);
    engine.render(&element);

    // THEN: Binding is resolved
    let captured = patches.lock().unwrap();
    // Check that SetProp patch has value "Alice"
}
```

### Example: Testing Reconciliation

```rust
#[test]
fn test_reconcile_children_reordered() {
    // GIVEN: Rendered tree with keyed children
    let mut engine = Engine::new();
    let initial = column_with_children(keyed_list(&["A", "B", "C"]));
    engine.render(&initial);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render with reordered children
    let reordered = column_with_children(keyed_list(&["C", "B", "A"]));
    engine.render(&reordered);

    // THEN: Move patches generated
    let captured = patches.lock().unwrap();
    assert_eq!(count_moves(&captured), 2);  // Moved C and A
}
```

## Adding New Utilities

When adding new test utilities:

1. **Fixtures**: Add to `fixtures.rs` if it's a commonly-used test object
2. **Matchers**: Add to `matchers.rs` if it's an assertion helper
3. **Helpers**: Add to `helpers.rs` if it's a utility function

Follow the existing patterns:
- Use clear, descriptive names
- Add doc comments with examples
- Keep functions focused and composable
- Export via `mod.rs` for easy access

## Running Tests

```bash
# Run all integration tests
cargo test --test test_common

# Run tests with output
cargo test --test test_common -- --nocapture

# Run specific test
cargo test --test test_common test_nested_tree_fixture
```
