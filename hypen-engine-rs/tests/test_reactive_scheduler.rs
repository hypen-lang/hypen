//! Tests for src/reactive/scheduler.rs - Dirty node tracking
//!
//! Tests scheduler for tracking which nodes need re-rendering

use hypen_engine::ir::NodeId;
use hypen_engine::reactive::scheduler::Scheduler;
use slotmap::SlotMap;
use std::sync::Mutex;

// Helper to create unique test NodeIds
lazy_static::lazy_static! {
    static ref NODE_POOL: Mutex<SlotMap<NodeId, ()>> = Mutex::new(SlotMap::with_key());
}

fn test_node_id() -> NodeId {
    let mut pool = NODE_POOL.lock().unwrap();
    pool.insert(())
}

// ============================================================================
// Mark Dirty Operations (4 tests)
// ============================================================================

#[test]
fn test_mark_single_node_dirty() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();
    let node_id = test_node_id();

    // WHEN: Mark node dirty
    scheduler.mark_dirty(node_id);

    // THEN: Has dirty nodes
    assert!(scheduler.has_dirty());
}

#[test]
fn test_mark_multiple_nodes_dirty_individually() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();
    let node1 = test_node_id();
    let node2 = test_node_id();
    let node3 = test_node_id();

    // WHEN: Mark multiple nodes dirty
    scheduler.mark_dirty(node1);
    scheduler.mark_dirty(node2);
    scheduler.mark_dirty(node3);

    // THEN: All marked as dirty
    let dirty = scheduler.take_dirty();
    assert_eq!(dirty.len(), 3);
    assert!(dirty.contains(&node1));
    assert!(dirty.contains(&node2));
    assert!(dirty.contains(&node3));
}

#[test]
fn test_mark_many_dirty_at_once() {
    // GIVEN: Scheduler and multiple node IDs
    let mut scheduler = Scheduler::new();
    let nodes = vec![
        test_node_id(),
        test_node_id(),
        test_node_id(),
        test_node_id(),
    ];

    // WHEN: Mark many dirty at once
    scheduler.mark_many_dirty(nodes.clone());

    // THEN: All nodes marked dirty
    let dirty = scheduler.take_dirty();
    assert_eq!(dirty.len(), 4);
    for node in nodes {
        assert!(dirty.contains(&node));
    }
}

#[test]
fn test_mark_same_node_dirty_twice_is_idempotent() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();
    let node_id = test_node_id();

    // WHEN: Mark same node dirty twice
    scheduler.mark_dirty(node_id);
    scheduler.mark_dirty(node_id);

    // THEN: Only stored once (IndexSet deduplicates)
    let dirty = scheduler.take_dirty();
    assert_eq!(dirty.len(), 1);
    assert!(dirty.contains(&node_id));
}

// ============================================================================
// Take/Clear Dirty Nodes (4 tests)
// ============================================================================

#[test]
fn test_take_dirty_returns_and_clears() {
    // GIVEN: Scheduler with dirty nodes
    let mut scheduler = Scheduler::new();
    let node1 = test_node_id();
    let node2 = test_node_id();
    scheduler.mark_dirty(node1);
    scheduler.mark_dirty(node2);

    // WHEN: Take dirty nodes
    let dirty = scheduler.take_dirty();

    // THEN: Returns dirty nodes
    assert_eq!(dirty.len(), 2);

    // AND: Scheduler is now empty
    assert!(!scheduler.has_dirty());
}

#[test]
fn test_take_dirty_on_empty_scheduler() {
    // GIVEN: Empty scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Take dirty nodes
    let dirty = scheduler.take_dirty();

    // THEN: Returns empty set
    assert_eq!(dirty.len(), 0);
    assert!(!scheduler.has_dirty());
}

#[test]
fn test_clear_removes_all_dirty_nodes() {
    // GIVEN: Scheduler with dirty nodes
    let mut scheduler = Scheduler::new();
    scheduler.mark_dirty(test_node_id());
    scheduler.mark_dirty(test_node_id());
    scheduler.mark_dirty(test_node_id());
    assert!(scheduler.has_dirty());

    // WHEN: Clear
    scheduler.clear();

    // THEN: No dirty nodes
    assert!(!scheduler.has_dirty());
}

#[test]
fn test_has_dirty_reflects_current_state() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Initially empty
    assert!(!scheduler.has_dirty());

    // WHEN: Mark node dirty
    scheduler.mark_dirty(test_node_id());
    assert!(scheduler.has_dirty());

    // WHEN: Clear
    scheduler.clear();
    assert!(!scheduler.has_dirty());

    // WHEN: Mark multiple dirty
    scheduler.mark_many_dirty(vec![test_node_id(), test_node_id()]);
    assert!(scheduler.has_dirty());

    // WHEN: Take dirty
    scheduler.take_dirty();
    assert!(!scheduler.has_dirty());
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_scheduler_default() {
    // GIVEN/WHEN: Create using default
    let scheduler = Scheduler::default();

    // THEN: Same as new() (no dirty nodes)
    assert!(!scheduler.has_dirty());
}

#[test]
fn test_multiple_take_dirty_cycles() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Mark dirty, take, mark dirty again, take again
    let node1 = test_node_id();
    let node2 = test_node_id();

    scheduler.mark_dirty(node1);
    let first_dirty = scheduler.take_dirty();
    assert_eq!(first_dirty.len(), 1);
    assert!(!scheduler.has_dirty());

    scheduler.mark_dirty(node2);
    let second_dirty = scheduler.take_dirty();
    assert_eq!(second_dirty.len(), 1);
    assert!(!scheduler.has_dirty());

    // THEN: Each cycle independent
    assert!(first_dirty.contains(&node1));
    assert!(second_dirty.contains(&node2));
}

#[test]
fn test_mark_many_dirty_with_empty_iterator() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Mark many with empty vec
    scheduler.mark_many_dirty(vec![]);

    // THEN: No dirty nodes
    assert!(!scheduler.has_dirty());
}

#[test]
fn test_mark_many_dirty_preserves_uniqueness() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();
    let node_id = test_node_id();

    // WHEN: Mark many with duplicate node IDs
    scheduler.mark_many_dirty(vec![node_id, node_id, node_id]);

    // THEN: Only stored once
    let dirty = scheduler.take_dirty();
    assert_eq!(dirty.len(), 1);
    assert!(dirty.contains(&node_id));
}

#[test]
fn test_scheduler_with_large_number_of_nodes() {
    // GIVEN: Scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Mark 1000 nodes dirty
    let nodes: Vec<NodeId> = (0..1000).map(|_| test_node_id()).collect();
    scheduler.mark_many_dirty(nodes.clone());

    // THEN: All 1000 nodes tracked
    let dirty = scheduler.take_dirty();
    assert_eq!(dirty.len(), 1000);
    for node in nodes {
        assert!(dirty.contains(&node));
    }
}

#[test]
fn test_clear_on_empty_scheduler_no_panic() {
    // GIVEN: Empty scheduler
    let mut scheduler = Scheduler::new();

    // WHEN: Clear empty scheduler
    scheduler.clear();

    // THEN: No panic, still empty
    assert!(!scheduler.has_dirty());
}
