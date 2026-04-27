//! Efficient state management using path-based change notifications
//!
//! The engine does NOT store state values - the host (JS/TS/Rust) does.
//! The engine only tracks WHICH paths changed to determine what to re-render.

use indexmap::IndexSet;
use serde_json::Value;

/// Represents a state change notification - just the paths that changed
#[derive(Debug, Clone)]
pub struct StateChange {
    /// Paths that changed (e.g., ["user.name", "count"])
    pub changed_paths: IndexSet<String>,
}

impl StateChange {
    pub fn new() -> Self {
        Self {
            changed_paths: IndexSet::new(),
        }
    }

    /// Add a changed path
    pub fn add_path(&mut self, path: impl Into<String>) {
        self.changed_paths.insert(path.into());
    }

    /// Create from a JSON patch object
    /// Extracts all paths from the patch
    pub fn from_json(patch: &Value) -> Self {
        let mut change = Self::new();
        extract_paths("", patch, &mut change.changed_paths);
        change
    }

    /// Create from a list of path strings
    pub fn from_paths(paths: impl IntoIterator<Item = String>) -> Self {
        Self {
            changed_paths: paths.into_iter().collect(),
        }
    }

    /// Get all changed paths
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.changed_paths.iter().map(|s| s.as_str())
    }

    /// Check if a specific path changed
    pub fn contains(&self, path: &str) -> bool {
        self.changed_paths.contains(path)
    }

    /// Check if any path with this prefix changed
    /// E.g., "user" would match "user", "user.name", "user.profile.bio"
    pub fn has_prefix(&self, prefix: &str) -> bool {
        self.changed_paths
            .iter()
            .any(|p| p == prefix || p.starts_with(&format!("{}.", prefix)))
    }
}

impl Default for StateChange {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract all paths from a JSON object
fn extract_paths(prefix: &str, value: &Value, paths: &mut IndexSet<String>) {
    match value {
        Value::Object(map) => {
            // Add the object path itself
            if !prefix.is_empty() {
                paths.insert(prefix.to_string());
            }

            // Recurse into children
            for (key, val) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", prefix, key)
                };
                extract_paths(&path, val, paths);
            }
        }
        _ => {
            // Leaf value
            if !prefix.is_empty() {
                paths.insert(prefix.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_paths() {
        let value = json!({
            "user": {
                "name": "Alice",
                "age": 30
            },
            "count": 42
        });

        let change = StateChange::from_json(&value);

        assert!(change.contains("user"));
        assert!(change.contains("user.name"));
        assert!(change.contains("user.age"));
        assert!(change.contains("count"));
    }

    #[test]
    fn test_has_prefix() {
        let mut change = StateChange::new();
        change.add_path("user.name");
        change.add_path("user.profile.bio");
        change.add_path("count");

        // "user" prefix matches both user.name and user.profile.bio
        assert!(change.has_prefix("user"));

        // "user.profile" matches user.profile.bio
        assert!(change.has_prefix("user.profile"));

        // "count" matches count
        assert!(change.has_prefix("count"));

        // "settings" doesn't match anything
        assert!(!change.has_prefix("settings"));
    }

    #[test]
    fn test_state_change_from_paths() {
        let paths = vec!["user.name".to_string(), "count".to_string()];
        let change = StateChange::from_paths(paths);

        assert_eq!(change.changed_paths.len(), 2);
        assert!(change.contains("user.name"));
        assert!(change.contains("count"));
    }
}
