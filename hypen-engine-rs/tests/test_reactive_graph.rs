//! Tests for src/reactive/graph.rs - Dependency tracking
//!
//! Tests the dependency graph that tracks which nodes depend on which state paths

use hypen_engine::ir::NodeId;
use hypen_engine::reactive::{Binding, DependencyGraph};
use slotmap::SlotMap;
use std::sync::Mutex;

// Helper to create unique test NodeIds
lazy_static::lazy_static! {
    static ref NODE_POOL: Mutex<SlotMap<NodeId, ()>> = Mutex::new(SlotMap::with_key());
}

fn node(_n: u32) -> NodeId {
    // Create unique NodeIds using a shared SlotMap
    let mut pool = NODE_POOL.lock().unwrap();
    pool.insert(())
}

// ============================================================================
// Dependency Tracking: Add, Get, Remove (6 tests)
// ============================================================================

#[test]
fn test_add_dependency_basic() {
    // GIVEN: Empty dependency graph
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    let binding = Binding::state(vec!["user".to_string(), "name".to_string()]);

    // WHEN: Add dependency
    graph.add_dependency(node_id, &binding,
        None,
);

    // THEN: Dependency recorded
    let nodes = graph.get_dependent_nodes("user.name");
    assert!(nodes.is_some());
    assert_eq!(nodes.unwrap().len(), 1);
    assert!(nodes.unwrap().contains(&node_id));
}

#[test]
fn test_add_multiple_nodes_same_path() {
    // GIVEN: Dependency graph
    let mut graph = DependencyGraph::new();
    let node1 = node(1);
    let node2 = node(2);
    let node3 = node(3);
    let binding = Binding::state(vec!["count".to_string()]);

    // WHEN: Multiple nodes depend on same path
    graph.add_dependency(node1, &binding,
        None,
);
    graph.add_dependency(node2, &binding,
        None,
);
    graph.add_dependency(node3, &binding,
        None,
);

    // THEN: All nodes tracked
    let nodes = graph.get_dependent_nodes("count");
    assert!(nodes.is_some());
    assert_eq!(nodes.unwrap().len(), 3);
}

#[test]
fn test_add_single_node_multiple_paths() {
    // GIVEN: Dependency graph
    let mut graph = DependencyGraph::new();
    let node_id = node(1);

    // WHEN: Single node depends on multiple paths
    graph.add_dependency(node_id, &Binding::state(vec!["firstName".to_string()]),
        None,
);
    graph.add_dependency(node_id, &Binding::state(vec!["lastName".to_string()]),
        None,
);
    graph.add_dependency(node_id, &Binding::state(vec!["email".to_string()]),
        None,
);

    // THEN: Node tracked for all paths
    assert!(graph
        .get_dependent_nodes("firstName")
        .unwrap()
        .contains(&node_id));
    assert!(graph
        .get_dependent_nodes("lastName")
        .unwrap()
        .contains(&node_id));
    assert!(graph
        .get_dependent_nodes("email")
        .unwrap()
        .contains(&node_id));
}

#[test]
fn test_get_dependent_nodes_nonexistent_path() {
    // GIVEN: Graph with some dependencies
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(node_id, &Binding::state(vec!["user".to_string()]),
        None,
);

    // WHEN: Query nonexistent path
    let nodes = graph.get_dependent_nodes("nonexistent");

    // THEN: Returns None
    assert!(nodes.is_none());
}

#[test]
fn test_remove_node_clears_all_dependencies() {
    // GIVEN: Node with multiple dependencies
    let mut graph = DependencyGraph::new();
    let node_id = node(1);

    graph.add_dependency(
        node_id,
        &Binding::state(vec!["user".to_string(), "name".to_string()]), None,
    );
    graph.add_dependency(
        node_id,
        &Binding::state(vec!["user".to_string(), "email".to_string()]), None,
    );
    graph.add_dependency(node_id, &Binding::state(vec!["settings".to_string()]),
        None,
);

    // Verify dependencies exist
    assert!(graph
        .get_dependent_nodes("user.name")
        .unwrap()
        .contains(&node_id));
    assert!(graph
        .get_dependent_nodes("user.email")
        .unwrap()
        .contains(&node_id));
    assert!(graph
        .get_dependent_nodes("settings")
        .unwrap()
        .contains(&node_id));

    // WHEN: Remove node
    graph.remove_node(node_id);

    // THEN: All dependencies cleared
    assert!(graph
        .get_dependent_nodes("user.name")
        .map_or(true, |n| !n.contains(&node_id)));
    assert!(graph
        .get_dependent_nodes("user.email")
        .map_or(true, |n| !n.contains(&node_id)));
    assert!(graph
        .get_dependent_nodes("settings")
        .map_or(true, |n| !n.contains(&node_id)));
}

#[test]
fn test_remove_node_preserves_other_nodes() {
    // GIVEN: Multiple nodes with same dependency
    let mut graph = DependencyGraph::new();
    let node1 = node(1);
    let node2 = node(2);
    let binding = Binding::state(vec!["shared".to_string()]);

    graph.add_dependency(node1, &binding,
        None,
);
    graph.add_dependency(node2, &binding,
        None,
);

    // WHEN: Remove one node
    graph.remove_node(node1);

    // THEN: Other node preserved
    let nodes = graph.get_dependent_nodes("shared").unwrap();
    assert!(!nodes.contains(&node1));
    assert!(nodes.contains(&node2));
    assert_eq!(nodes.len(), 1);
}

// ============================================================================
// Path Affectedness: Parent/Child Changes (5 tests)
// ============================================================================

#[test]
fn test_get_affected_nodes_exact_match() {
    // GIVEN: Node depends on "user.name"
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(
        node_id,
        &Binding::state(vec!["user".to_string(), "name".to_string()]), None,
    );

    // WHEN: "user.name" changes
    let affected = graph.get_affected_nodes("user.name");

    // THEN: Node is affected
    assert_eq!(affected.len(), 1);
    assert!(affected.contains(&node_id));
}

#[test]
fn test_get_affected_nodes_parent_changed() {
    // GIVEN: Node depends on "user.profile.name"
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(
        node_id,
        &Binding::state(vec![
            "user".to_string(),
            "profile".to_string(),
            "name".to_string(),
        ]), None,
    );

    // WHEN: Parent "user" changes
    let affected = graph.get_affected_nodes("user");

    // THEN: Child node is affected
    assert_eq!(affected.len(), 1);
    assert!(affected.contains(&node_id));
}

#[test]
fn test_get_affected_nodes_child_changed() {
    // GIVEN: Node depends on parent "user"
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(node_id, &Binding::state(vec!["user".to_string()]),
        None,
);

    // WHEN: Child "user.email" changes
    let affected = graph.get_affected_nodes("user.email");

    // THEN: Parent node is affected
    assert_eq!(affected.len(), 1);
    assert!(affected.contains(&node_id));
}

#[test]
fn test_get_affected_nodes_unrelated_path() {
    // GIVEN: Node depends on "user.name"
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(
        node_id,
        &Binding::state(vec!["user".to_string(), "name".to_string()]), None,
    );

    // WHEN: Unrelated "settings" changes
    let affected = graph.get_affected_nodes("settings");

    // THEN: No nodes affected
    assert_eq!(affected.len(), 0);
}

#[test]
fn test_get_affected_nodes_similar_but_different_paths() {
    // GIVEN: Node depends on "user"
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    graph.add_dependency(node_id, &Binding::state(vec!["user".to_string()]),
        None,
);

    // WHEN: Similar but different "username" changes
    let affected = graph.get_affected_nodes("username");

    // THEN: Node NOT affected (not a child path)
    assert_eq!(affected.len(), 0);
}

// ============================================================================
// Clear and Bulk Operations (4 tests)
// ============================================================================

#[test]
fn test_clear_removes_all_dependencies() {
    // GIVEN: Graph with many dependencies
    let mut graph = DependencyGraph::new();

    for i in 0..10 {
        let node_id = node(i);
        graph.add_dependency(node_id, &Binding::state(vec![format!("path{}", i)]),
        None,
);
    }

    // Verify dependencies exist
    assert!(graph.get_dependent_nodes("path0").is_some());
    assert!(graph.get_dependent_nodes("path5").is_some());

    // WHEN: Clear graph
    graph.clear();

    // THEN: All dependencies removed
    assert!(graph.get_dependent_nodes("path0").is_none());
    assert!(graph.get_dependent_nodes("path5").is_none());
    assert!(graph.get_dependent_nodes("path9").is_none());
}

#[test]
fn test_affected_nodes_with_multiple_dependencies() {
    // GIVEN: Multiple nodes with nested dependencies
    let mut graph = DependencyGraph::new();
    let node1 = node(1); // Depends on "user"
    let node2 = node(2); // Depends on "user.name"
    let node3 = node(3); // Depends on "user.profile.avatar"

    graph.add_dependency(node1, &Binding::state(vec!["user".to_string()]),
        None,
);
    graph.add_dependency(
        node2,
        &Binding::state(vec!["user".to_string(), "name".to_string()]), None,
    );
    graph.add_dependency(
        node3,
        &Binding::state(vec![
            "user".to_string(),
            "profile".to_string(),
            "avatar".to_string(),
        ]), None,
    );

    // WHEN: "user.profile" changes
    let affected = graph.get_affected_nodes("user.profile");

    // THEN: Both parent (user) and child (user.profile.avatar) affected
    assert_eq!(affected.len(), 2); // node1 (user) and node3 (user.profile.avatar)
    assert!(affected.contains(&node1));
    assert!(!affected.contains(&node2)); // user.name is sibling, not affected
    assert!(affected.contains(&node3));
}

#[test]
fn test_dependency_graph_default() {
    // GIVEN: Default constructor
    let graph = DependencyGraph::default();

    // WHEN: Query any path
    let nodes = graph.get_dependent_nodes("anything");

    // THEN: Empty graph
    assert!(nodes.is_none());
}

#[test]
fn test_add_same_dependency_twice_idempotent() {
    // GIVEN: Dependency graph
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    let binding = Binding::state(vec!["count".to_string()]);

    // WHEN: Add same dependency twice
    graph.add_dependency(node_id, &binding,
        None,
);
    graph.add_dependency(node_id, &binding,
        None,
);

    // THEN: Only stored once (IndexSet deduplicates)
    let nodes = graph.get_dependent_nodes("count");
    assert!(nodes.is_some());
    assert_eq!(nodes.unwrap().len(), 1);
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_deeply_nested_path_tracking() {
    // GIVEN: Very deeply nested binding
    let mut graph = DependencyGraph::new();
    let node_id = node(1);
    let binding = Binding::state(vec![
        "a".to_string(),
        "b".to_string(),
        "c".to_string(),
        "d".to_string(),
        "e".to_string(),
    ]);

    graph.add_dependency(node_id, &binding,
        None,
);

    // WHEN: Query affected nodes at various levels
    let affected_root = graph.get_affected_nodes("a");
    let affected_mid = graph.get_affected_nodes("a.b.c");
    let affected_leaf = graph.get_affected_nodes("a.b.c.d.e");
    let affected_deeper = graph.get_affected_nodes("a.b.c.d.e.f");

    // THEN: All parent and child changes affect the node
    assert!(affected_root.contains(&node_id)); // Parent change
    assert!(affected_mid.contains(&node_id)); // Mid-parent change
    assert!(affected_leaf.contains(&node_id)); // Exact match
    assert!(affected_deeper.contains(&node_id)); // Child change
}
