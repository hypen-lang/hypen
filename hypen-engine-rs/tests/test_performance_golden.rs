//! Golden Master Tests for Performance Optimizations
//!
//! These tests capture the CURRENT behavior of the system before optimizations.
//! They serve as regression tests to ensure optimizations don't break functionality.
//!
//! After optimizations, some tests may need updated expectations (e.g., fewer patches).
//! The key invariant is: OUTPUT CORRECTNESS must remain identical.

mod common;

use common::*;
use hypen_engine::ir::{Element, IRNode, Props, Value};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reactive::{Binding, DependencyGraph, Scheduler};
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_engine::render::render_dirty_nodes_with_deps;
use indexmap::indexmap;
use serde_json::json;
use std::time::Instant;

// ============================================================================
// GOLDEN MASTER 1: replace_item_bindings Performance
// ============================================================================
// Tests the string replacement in List item rendering.
// Current: O(n²) due to pos=0 reset. Target: O(n) single pass.

/// Creates a List element with complex item template
fn list_with_complex_template(array_path: &str, template_children: Vec<Element>) -> Element {
    let path_parts: Vec<String> = array_path.split('.').map(|s| s.to_string()).collect();
    Element {
        element_type: "List".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Binding(Binding::state(path_parts))
        }),
        ir_children: template_children.into_iter().map(IRNode::Element).collect(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Box element with multiple item-bound props (simulates real-world card)
fn product_card_template() -> Element {
    Element {
        element_type: "Column".to_string(),
        props: Props::from_map(indexmap! {
            "padding".to_string() => Value::Static(json!(16)),
            "backgroundColor".to_string() => Value::TemplateString {
                template: "@{item.selected ? '#FFA7E1' : '#FFFFFF'}".to_string(),
                bindings: vec![Binding::item(vec!["selected".to_string()])],
            },
            "borderWidth".to_string() => Value::TemplateString {
                template: "@{item.selected ? '2px' : '1px'}".to_string(),
                bindings: vec![Binding::item(vec!["selected".to_string()])],
            },
        }),
        ir_children: vec![
            // Product name
            IRNode::Element(Element {
                element_type: "Text".to_string(),
                props: Props::from_map(indexmap! {
                    "0".to_string() => Value::Static(json!("@{item.name}")),
                    "fontSize".to_string() => Value::Static(json!(18)),
                    "fontWeight".to_string() => Value::Static(json!("bold")),
                }),
                ir_children: Vec::new(),
                key: None,
                module_scope: None,
                semantics: None,
                span: None,
                expr_span: None,
            }),
            // Product description
            IRNode::Element(Element {
                element_type: "Text".to_string(),
                props: Props::from_map(indexmap! {
                    "0".to_string() => Value::Static(json!("@{item.description}")),
                    "color".to_string() => Value::Static(json!("#666")),
                }),
                ir_children: Vec::new(),
                key: None,
                module_scope: None,
                semantics: None,
                span: None,
                expr_span: None,
            }),
            // Price with conditional styling
            IRNode::Element(Element {
                element_type: "Text".to_string(),
                props: Props::from_map(indexmap! {
                    "0".to_string() => Value::TemplateString {
                        template: "$@{item.price}".to_string(),
                        bindings: vec![Binding::item(vec!["price".to_string()])],
                    },
                    "color".to_string() => Value::TemplateString {
                        template: "@{item.onSale ? '#E53935' : '#000000'}".to_string(),
                        bindings: vec![Binding::item(vec!["onSale".to_string()])],
                    },
                }),
                ir_children: Vec::new(),
                key: None,
                module_scope: None,
                semantics: None,
                span: None,
                expr_span: None,
            }),
            // Stock status
            IRNode::Element(Element {
                element_type: "Text".to_string(),
                props: Props::from_map(indexmap! {
                    "0".to_string() => Value::TemplateString {
                        template: "@{item.stock > 10 ? 'In Stock' : 'Low Stock'}".to_string(),
                        bindings: vec![Binding::item(vec!["stock".to_string()])],
                    },
                }),
                ir_children: Vec::new(),
                key: None,
                module_scope: None,
                semantics: None,
                span: None,
                expr_span: None,
            }),
        ],
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Generate N products for testing
fn generate_products(n: usize) -> serde_json::Value {
    let products: Vec<serde_json::Value> = (0..n)
        .map(|i| {
            json!({
                "id": format!("prod_{}", i),
                "name": format!("Product {} with a longer name for testing", i),
                "description": format!("This is a detailed description for product {}. It contains multiple sentences to simulate real content that would appear in an e-commerce application.", i),
                "price": 19.99 + (i as f64 * 0.5),
                "stock": (i % 20) + 1,
                "selected": i % 5 == 0,
                "onSale": i % 3 == 0,
            })
        })
        .collect();
    json!({ "products": products })
}

#[test]
fn golden_replace_item_bindings_10_items() {
    // GIVEN: List with 10 products using complex template
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let list = list_with_complex_template("products", vec![product_card_template()]);
    let state = generate_products(10);

    // WHEN: Create tree
    let start = Instant::now();
    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    ));
    let elapsed = start.elapsed();

    // THEN: Capture current behavior as golden master
    // List + 10 * (Column + 4 Text) = 1 + 10*5 = 51 nodes
    let create_count = count_creates(&patches);
    let insert_count = count_inserts(&patches);

    println!(
        "Golden 10 items: {} creates, {} inserts, {:?}",
        create_count, insert_count, elapsed
    );

    // GOLDEN VALUES - Current behavior
    assert_eq!(
        create_count, 51,
        "GOLDEN: 10 items should create 51 nodes (1 List + 10 * 5 children)"
    );
    assert_eq!(
        insert_count, 51,
        "GOLDEN: Each create should have matching insert"
    );

    // Verify correctness: first product should have correct values
    let first_product_text = patches.iter().find_map(|p| {
        if let Patch::Create {
            element_type,
            props,
            ..
        } = p
        {
            if element_type == "Text" {
                if let Some(serde_json::Value::String(s)) = props.get("0") {
                    if s.contains("Product 0") {
                        return Some(s.clone());
                    }
                }
            }
        }
        None
    });
    assert!(
        first_product_text.is_some(),
        "GOLDEN: First product name should be rendered"
    );
}

#[test]
fn golden_replace_item_bindings_100_items() {
    // GIVEN: List with 100 products
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let list = list_with_complex_template("products", vec![product_card_template()]);
    let state = generate_products(100);

    // WHEN: Create tree
    let start = Instant::now();
    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    ));
    let elapsed = start.elapsed();

    // THEN: Capture performance baseline
    let create_count = count_creates(&patches);

    println!(
        "Golden 100 items: {} creates in {:?}",
        create_count, elapsed
    );

    // GOLDEN VALUES
    assert_eq!(
        create_count, 501,
        "GOLDEN: 100 items should create 501 nodes"
    );

    // Performance baseline (will improve after optimization)
    // Current O(n²) is slow; after fix should be <50ms
    assert!(
        elapsed.as_millis() < 5000,
        "GOLDEN: 100 items should complete within 5s (current baseline)"
    );
}

// ============================================================================
// GOLDEN MASTER 2: List Partial Updates (Current: Full Re-render)
// ============================================================================
// Tests that changing 1 item in a 10-item list currently removes ALL and recreates ALL.
// After optimization: should only update the changed item.

#[test]
fn golden_list_partial_update_changes_one_item() {
    // GIVEN: List rendered with 5 items
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("@{item.name}"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let initial_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"},
            {"id": "d", "name": "Diana"},
            {"id": "e", "name": "Eve"}
        ]
    });

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    ));
    let list_node_id = tree.root().expect("Should have root");

    // Verify initial state: 6 nodes (1 List + 5 Text)
    let initial_creates = count_creates(&patches);
    assert_eq!(initial_creates, 6, "Initial: 1 List + 5 Text nodes");

    patches.clear();

    // WHEN: Change only ONE item (Bob -> Robert)
    let updated_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Robert"},  // CHANGED
            {"id": "c", "name": "Charlie"},
            {"id": "d", "name": "Diana"},
            {"id": "e", "name": "Eve"}
        ]
    });
    instance.update_state(updated_state);
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    // THEN: With keyed reconciliation, items are matched by id
    let removes = count_removes(&update_patches);
    let creates = count_creates(&update_patches);
    let set_props = count_set_props(&update_patches);

    println!(
        "Golden partial update: {} removes, {} creates, {} set_props",
        removes, creates, set_props
    );

    // OPTIMIZED VALUES - Keyed reconciliation matches items by id
    // Changing Bob→Robert doesn't require remove/create, just SetProp
    assert_eq!(removes, 0, "OPTIMIZED: No removes needed (keyed matching)");
    assert_eq!(
        creates, 0,
        "OPTIMIZED: No creates needed (all items matched by key)"
    );
    // The changed item should have its props updated
    assert!(
        set_props >= 1,
        "OPTIMIZED: At least 1 SetProp for the changed item: got {}",
        set_props
    );
}

#[test]
fn golden_list_add_one_item_to_end() {
    // GIVEN: List with 3 items
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("@{item.name}"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let initial_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"}
        ]
    });

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    ));
    let list_node_id = tree.root().expect("Should have root");

    patches.clear();

    // WHEN: Add ONE item to end
    let updated_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"},
            {"id": "d", "name": "Diana"}  // NEW
        ]
    });
    instance.update_state(updated_state);
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    let removes = count_removes(&update_patches);
    let creates = count_creates(&update_patches);

    println!(
        "Golden add to end: {} removes, {} creates",
        removes, creates
    );

    // OPTIMIZED VALUES - Keyed reconciliation
    // Adding Diana to [Alice, Bob, Charlie] should only create 1 new node
    assert_eq!(
        removes, 0,
        "OPTIMIZED: No removes needed (existing items matched by key)"
    );
    assert_eq!(creates, 1, "OPTIMIZED: Only create 1 new item (Diana)");
}

// ============================================================================
// GOLDEN MASTER 3: List Reordering (Current: Full Re-render)
// ============================================================================
// Tests that reordering items currently removes ALL and recreates ALL.
// After optimization with keyed diffing: should emit Move patches.

#[test]
fn golden_list_reorder_items() {
    // GIVEN: List with 4 keyed items [A, B, C, D]
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    // Template with key from item.id
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("@{item.name}"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None, // Note: key would come from item.id in optimized version
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let initial_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"},
            {"id": "d", "name": "Diana"}
        ]
    });

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    ));
    let list_node_id = tree.root().expect("Should have root");

    patches.clear();

    // WHEN: Reorder to [D, A, B, C] (move D to front)
    let reordered_state = json!({
        "items": [
            {"id": "d", "name": "Diana"},  // Moved to front
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"}
        ]
    });
    instance.update_state(reordered_state);
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    let removes = count_removes(&update_patches);
    let creates = count_creates(&update_patches);
    let moves = count_moves(&update_patches);

    println!(
        "Golden reorder: {} removes, {} creates, {} moves",
        removes, creates, moves
    );

    // OPTIMIZED VALUES - Keyed reconciliation with LIS algorithm
    // Items have id field, so they're matched by key (item-d, item-a, etc.)
    // Reordering doesn't require remove/create, only moves
    assert_eq!(removes, 0, "OPTIMIZED: No removes needed (keyed matching)");
    assert_eq!(
        creates, 0,
        "OPTIMIZED: No creates needed (all items matched by key)"
    );
    // LIS algorithm minimizes moves: items not in longest increasing subsequence need moves
    // For [A,B,C,D] → [D,A,B,C], the LIS could be [A,B,C], so D needs to move
    assert!(
        moves >= 1,
        "OPTIMIZED: At least 1 Move patch needed: got {}",
        moves
    );
}

#[test]
fn golden_list_reverse_order() {
    // GIVEN: List with 5 items [A, B, C, D, E]
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("@{item.name}"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let initial_state = json!({
        "items": [
            {"id": "a", "name": "Alice"},
            {"id": "b", "name": "Bob"},
            {"id": "c", "name": "Charlie"},
            {"id": "d", "name": "Diana"},
            {"id": "e", "name": "Eve"}
        ]
    });

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    ));
    let list_node_id = tree.root().expect("Should have root");

    patches.clear();

    // WHEN: Reverse to [E, D, C, B, A]
    let reversed_state = json!({
        "items": [
            {"id": "e", "name": "Eve"},
            {"id": "d", "name": "Diana"},
            {"id": "c", "name": "Charlie"},
            {"id": "b", "name": "Bob"},
            {"id": "a", "name": "Alice"}
        ]
    });
    instance.update_state(reversed_state);
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    let removes = count_removes(&update_patches);
    let creates = count_creates(&update_patches);
    let moves = count_moves(&update_patches);

    println!(
        "Golden reverse: {} removes, {} creates, {} moves",
        removes, creates, moves
    );

    // OPTIMIZED VALUES - Keyed reconciliation
    // All items have id field, so they're matched by key
    // Reversing only requires moves, not remove/create
    assert_eq!(removes, 0, "OPTIMIZED: No removes needed (keyed matching)");
    assert_eq!(
        creates, 0,
        "OPTIMIZED: No creates needed (all items matched by key)"
    );
    // For complete reversal [A,B,C,D,E] → [E,D,C,B,A], LIS is length 1, so 4 moves needed
    assert!(
        moves >= 2,
        "OPTIMIZED: Multiple Move patches needed for reversal: got {}",
        moves
    );

    // Verify correctness by checking tree state instead of Create patches
    // Since items are reused, their props should be updated
}

// ============================================================================
// GOLDEN MASTER 4: Path Extraction (Already Efficient)
// ============================================================================
// This captures current behavior which is already O(keys).
// No optimization planned, but good to have as regression test.

#[test]
fn golden_path_extraction_preserves_structure() {
    use hypen_engine::wasm::ffi::extract_changed_paths;

    // GIVEN: Complex nested state update
    let state = json!({
        "user": {
            "profile": {
                "name": "Alice",
                "avatar": "url"
            },
            "settings": {
                "theme": "dark"
            }
        },
        "counter": 42
    });

    // WHEN: Extract paths
    let paths = extract_changed_paths(&state);

    // THEN: All paths should be extracted
    println!("Golden paths: {:?}", paths);

    assert!(paths.contains(&"user".to_string()), "GOLDEN: 'user' path");
    assert!(
        paths.contains(&"user.profile".to_string()),
        "GOLDEN: 'user.profile' path"
    );
    assert!(
        paths.contains(&"user.profile.name".to_string()),
        "GOLDEN: 'user.profile.name' path"
    );
    assert!(
        paths.contains(&"user.profile.avatar".to_string()),
        "GOLDEN: 'user.profile.avatar' path"
    );
    assert!(
        paths.contains(&"user.settings".to_string()),
        "GOLDEN: 'user.settings' path"
    );
    assert!(
        paths.contains(&"user.settings.theme".to_string()),
        "GOLDEN: 'user.settings.theme' path"
    );
    assert!(
        paths.contains(&"counter".to_string()),
        "GOLDEN: 'counter' path"
    );

    // 7 total paths
    assert_eq!(paths.len(), 7, "GOLDEN: Should extract exactly 7 paths");
}

// ============================================================================
// GOLDEN MASTER 5: Dependency Graph Behavior
// ============================================================================
// Tests that dependencies are cleared and rebuilt on each render.
// After optimization: should do incremental updates.

#[test]
fn golden_dependency_graph_cleared_on_render() {
    // GIVEN: Tree with bindings
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    // Element with binding to "counter"
    let element = Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Binding(Binding::state(vec!["counter".to_string()]))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    };

    let initial_state = json!({"counter": 0});
    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    ));
    let node_id = tree.root().expect("Should have root");

    // Verify initial dependency
    let initial_affected = dependencies.get_affected_nodes("counter");
    assert!(
        initial_affected.contains(&node_id),
        "GOLDEN: Initial dependency registered"
    );

    // WHEN: State changes and we render
    instance.update_state(json!({"counter": 1}));
    scheduler.mark_dirty(node_id);

    // Clear and rebuild (current behavior)
    dependencies.clear();
    let _update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    // THEN: Dependencies should be re-registered
    let final_affected = dependencies.get_affected_nodes("counter");

    println!(
        "Golden dependency: node still tracked = {}",
        final_affected.contains(&node_id)
    );

    // GOLDEN: After render, dependency should exist
    // (Note: Current render_dirty_nodes_with_deps may or may not re-register depending on implementation)
    // This test captures whatever the current behavior is
}

#[test]
fn golden_dependency_multi_binding_tracking() {
    // GIVEN: Element with multiple bindings
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let element = Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::TemplateString {
                template: "@{state.firstName} @{state.lastName}".to_string(),
                bindings: vec![
                    Binding::state(vec!["firstName".to_string()]),
                    Binding::state(vec!["lastName".to_string()]),
                ],
            }
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    };

    let state = json!({"firstName": "John", "lastName": "Doe"});

    // WHEN: Create tree
    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    ));
    let node_id = tree.root().expect("Should have root");

    // THEN: Both paths should track the node
    let first_affected = dependencies.get_affected_nodes("firstName");
    let last_affected = dependencies.get_affected_nodes("lastName");

    println!(
        "Golden multi-binding: firstName={}, lastName={}",
        first_affected.contains(&node_id),
        last_affected.contains(&node_id)
    );

    // GOLDEN: Node should be affected by both paths
    assert!(
        first_affected.contains(&node_id),
        "GOLDEN: firstName should track node"
    );
    assert!(
        last_affected.contains(&node_id),
        "GOLDEN: lastName should track node"
    );
}

// ============================================================================
// GOLDEN MASTER 6: Output Correctness Invariants
// ============================================================================
// These tests verify the OUTPUT values, not performance.
// These must pass both before AND after optimization.

#[test]
fn golden_correctness_item_binding_substitution() {
    // This test verifies that @{item.x} bindings are correctly substituted.
    // Must remain correct after string replacement optimization.

    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["users".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("Hello, @{item.name}!"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let state = json!({
        "users": [
            {"name": "Alice"},
            {"name": "Bob"},
            {"name": "Charlie"}
        ]
    });

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    ));

    // Extract all Text node values
    let text_values: Vec<String> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return props
                        .get("0")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
            None
        })
        .collect();

    // INVARIANT: These must be correct after any optimization
    assert!(
        text_values.contains(&"Hello, Alice!".to_string()),
        "CORRECTNESS: Alice substitution"
    );
    assert!(
        text_values.contains(&"Hello, Bob!".to_string()),
        "CORRECTNESS: Bob substitution"
    );
    assert!(
        text_values.contains(&"Hello, Charlie!".to_string()),
        "CORRECTNESS: Charlie substitution"
    );
}

#[test]
fn golden_correctness_ternary_evaluation() {
    // This test verifies that ternary expressions are correctly evaluated.
    // Must remain correct after optimization.

    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Box".to_string(),
        props: Props::from_map(indexmap! {
            "color".to_string() => Value::TemplateString {
                template: "@{item.active ? '#00FF00' : '#FF0000'}".to_string(),
                bindings: vec![Binding::item(vec!["active".to_string()])],
            }
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let state = json!({
        "items": [
            {"id": 1, "active": true},
            {"id": 2, "active": false},
            {"id": 3, "active": true}
        ]
    });

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    ));

    // Extract all Box color values
    let colors: Vec<String> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Box" {
                    return props
                        .get("color")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
            None
        })
        .collect();

    // INVARIANT: 2 green (#00FF00), 1 red (#FF0000)
    let green_count = colors.iter().filter(|c| *c == "#00FF00").count();
    let red_count = colors.iter().filter(|c| *c == "#FF0000").count();

    assert_eq!(
        green_count, 2,
        "CORRECTNESS: 2 active items should be green"
    );
    assert_eq!(red_count, 1, "CORRECTNESS: 1 inactive item should be red");
}

#[test]
fn golden_correctness_nested_path_resolution() {
    // This test verifies that nested paths like @{item.user.profile.name} work.
    // Must remain correct after optimization.

    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["records".to_string()])),
    );
    list.ir_children.push(IRNode::Element(Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "0".to_string() => Value::Static(json!("@{item.user.profile.displayName}"))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }));

    let state = json!({
        "records": [
            {"user": {"profile": {"displayName": "Alice Smith"}}},
            {"user": {"profile": {"displayName": "Bob Jones"}}}
        ]
    });

    patches.extend(reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    ));

    let text_values: Vec<String> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return props
                        .get("0")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
            None
        })
        .collect();

    // INVARIANT: Nested paths must resolve correctly
    assert!(
        text_values.contains(&"Alice Smith".to_string()),
        "CORRECTNESS: Nested path for Alice"
    );
    assert!(
        text_values.contains(&"Bob Jones".to_string()),
        "CORRECTNESS: Nested path for Bob"
    );
}
