//! Test helpers - utility functions for common test operations
#![allow(dead_code)]

use hypen_engine::ir::NodeId;
use hypen_engine::reconcile::InstanceTree;

// ========== Tree Helpers ==========

/// Count the total number of nodes in an instance tree
pub fn count_tree_nodes(tree: &InstanceTree) -> usize {
    if let Some(root_id) = tree.root() {
        count_nodes_recursive(tree, root_id)
    } else {
        0
    }
}

/// Recursively count nodes in a subtree
fn count_nodes_recursive(tree: &InstanceTree, node_id: NodeId) -> usize {
    if let Some(node) = tree.get(node_id) {
        let children_count: usize = node
            .children
            .iter()
            .map(|&child_id| count_nodes_recursive(tree, child_id))
            .sum();
        1 + children_count
    } else {
        0
    }
}

/// Get all node IDs in the tree (breadth-first)
pub fn collect_node_ids(tree: &InstanceTree) -> Vec<NodeId> {
    let mut ids = Vec::new();
    if let Some(root_id) = tree.root() {
        let mut queue = vec![root_id];
        while let Some(node_id) = queue.pop() {
            ids.push(node_id);
            if let Some(node) = tree.get(node_id) {
                queue.extend(node.children.iter().copied());
            }
        }
    }
    ids
}

/// Get the depth of the tree
pub fn tree_depth(tree: &InstanceTree) -> usize {
    if let Some(root_id) = tree.root() {
        depth_recursive(tree, root_id)
    } else {
        0
    }
}

fn depth_recursive(tree: &InstanceTree, node_id: NodeId) -> usize {
    if let Some(node) = tree.get(node_id) {
        if node.children.is_empty() {
            1
        } else {
            1 + node
                .children
                .iter()
                .map(|&child_id| depth_recursive(tree, child_id))
                .max()
                .unwrap_or(0)
        }
    } else {
        0
    }
}

/// Find a node by element type
pub fn find_node_by_type(tree: &InstanceTree, element_type: &str) -> Option<NodeId> {
    if let Some(root_id) = tree.root() {
        find_node_by_type_recursive(tree, root_id, element_type)
    } else {
        None
    }
}

fn find_node_by_type_recursive(
    tree: &InstanceTree,
    node_id: NodeId,
    element_type: &str,
) -> Option<NodeId> {
    if let Some(node) = tree.get(node_id) {
        if node.element_type == element_type {
            return Some(node_id);
        }
        for &child_id in &node.children {
            if let Some(found) = find_node_by_type_recursive(tree, child_id, element_type) {
                return Some(found);
            }
        }
    }
    None
}

// ========== Path Helpers ==========

/// Split a state path into segments
/// Example: "user.profile.name" -> ["user", "profile", "name"]
pub fn split_path(path: &str) -> Vec<String> {
    path.split('.').map(|s| s.to_string()).collect()
}

/// Check if one path is a prefix of another
/// Example: is_prefix("user", "user.name") -> true
pub fn is_path_prefix(prefix: &str, path: &str) -> bool {
    if prefix == path {
        return true;
    }
    path.starts_with(prefix) && path[prefix.len()..].starts_with('.')
}

/// Get parent path
/// Example: parent_path("user.profile.name") -> Some("user.profile")
pub fn parent_path(path: &str) -> Option<String> {
    path.rfind('.').map(|i| path[..i].to_string())
}

// ========== Timing Helpers ==========

/// Measure execution time of a function
pub fn measure_time<F, T>(f: F) -> (T, std::time::Duration)
where
    F: FnOnce() -> T,
{
    let start = std::time::Instant::now();
    let result = f();
    let duration = start.elapsed();
    (result, duration)
}

/// Assert that a function completes within a time limit
pub fn assert_completes_within<F, T>(duration: std::time::Duration, f: F) -> T
where
    F: FnOnce() -> T,
{
    let (result, elapsed) = measure_time(f);
    assert!(
        elapsed <= duration,
        "Function took {:?}, expected <= {:?}",
        elapsed,
        duration
    );
    result
}

// ========== Comparison Helpers ==========

/// Compare two JSON values with a custom equality check
pub fn json_equals_ignore_order(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;

    match (a, b) {
        (Value::Object(a_map), Value::Object(b_map)) => {
            if a_map.len() != b_map.len() {
                return false;
            }
            a_map.iter().all(|(key, a_val)| {
                b_map
                    .get(key)
                    .map(|b_val| json_equals_ignore_order(a_val, b_val))
                    .unwrap_or(false)
            })
        }
        (Value::Array(a_arr), Value::Array(b_arr)) => {
            if a_arr.len() != b_arr.len() {
                return false;
            }
            // For arrays, we compare element by element (order matters)
            a_arr
                .iter()
                .zip(b_arr.iter())
                .all(|(a_val, b_val)| json_equals_ignore_order(a_val, b_val))
        }
        _ => a == b,
    }
}

// ========== Debug Helpers ==========

/// Print tree structure for debugging
#[allow(dead_code)]
pub fn print_tree(tree: &InstanceTree) {
    if let Some(root_id) = tree.root() {
        print_node_recursive(tree, root_id, 0);
    } else {
        println!("Empty tree");
    }
}

fn print_node_recursive(tree: &InstanceTree, node_id: NodeId, depth: usize) {
    if let Some(node) = tree.get(node_id) {
        let indent = "  ".repeat(depth);
        println!(
            "{}{} (id: {:?}, key: {:?})",
            indent, node.element_type, node_id, node.key
        );
        for &child_id in &node.children {
            print_node_recursive(tree, child_id, depth + 1);
        }
    }
}

/// Print patches for debugging
#[allow(dead_code)]
pub fn print_patches(patches: &[hypen_engine::reconcile::Patch]) {
    println!("Patches ({}):", patches.len());
    for (i, patch) in patches.iter().enumerate() {
        println!("  [{}] {:?}", i, patch);
    }
}

// ========== Snapshot Helpers ==========

/// Create a simple snapshot of a tree structure (for comparison)
pub fn tree_snapshot(tree: &InstanceTree) -> String {
    if let Some(root_id) = tree.root() {
        snapshot_node_recursive(tree, root_id, 0)
    } else {
        "Empty".to_string()
    }
}

fn snapshot_node_recursive(tree: &InstanceTree, node_id: NodeId, depth: usize) -> String {
    if let Some(node) = tree.get(node_id) {
        let indent = "  ".repeat(depth);
        let mut result = format!("{}{}", indent, node.element_type);

        if let Some(key) = &node.key {
            result.push_str(&format!("[key={}]", key));
        }

        result.push('\n');

        for &child_id in &node.children {
            result.push_str(&snapshot_node_recursive(tree, child_id, depth + 1));
        }

        result
    } else {
        String::new()
    }
}

// ========== Collection Helpers ==========

/// Create a range of numbers as a vector
pub fn range_vec(start: usize, end: usize) -> Vec<usize> {
    (start..end).collect()
}

/// Repeat a value n times in a vector
pub fn repeat_vec<T: Clone>(value: T, n: usize) -> Vec<T> {
    vec![value; n]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_path() {
        assert_eq!(split_path("user"), vec!["user"]);
        assert_eq!(split_path("user.name"), vec!["user", "name"]);
        assert_eq!(
            split_path("user.profile.avatar"),
            vec!["user", "profile", "avatar"]
        );
    }

    #[test]
    fn test_is_path_prefix() {
        assert!(is_path_prefix("user", "user"));
        assert!(is_path_prefix("user", "user.name"));
        assert!(is_path_prefix("user.profile", "user.profile.avatar"));
        assert!(!is_path_prefix("user", "username"));
        assert!(!is_path_prefix("user.name", "user"));
    }

    #[test]
    fn test_parent_path() {
        assert_eq!(parent_path("user"), None);
        assert_eq!(parent_path("user.name"), Some("user".to_string()));
        assert_eq!(
            parent_path("user.profile.avatar"),
            Some("user.profile".to_string())
        );
    }
}
