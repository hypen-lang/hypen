use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::error::{Result, SdkError};

/// Trait for types that can be used as module state.
///
/// Any struct that implements `Serialize + DeserializeOwned + Clone + Send + Sync`
/// can serve as module state. The SDK uses serde to convert between the typed
/// state and JSON, and diffs JSON snapshots to detect which paths changed.
///
/// # Example
///
/// ```rust
/// use serde::{Deserialize, Serialize};
///
/// #[derive(Clone, Default, Serialize, Deserialize)]
/// struct CounterState {
///     count: i32,
///     label: String,
/// }
/// ```
pub trait State: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {}

/// Blanket implementation: any type meeting the bounds is automatically `State`.
impl<T> State for T where T: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {}

/// Holds the typed state alongside its JSON representation for efficient diffing.
pub(crate) struct StateContainer<S: State> {
    /// The typed state value — what users interact with.
    value: S,
    /// JSON snapshot taken *before* the most recent handler ran.
    /// Used to compute changed paths after mutation.
    snapshot: Value,
}

impl<S: State> StateContainer<S> {
    /// Create a new container, serializing the initial state to JSON.
    pub fn new(initial: S) -> Result<Self> {
        let snapshot =
            serde_json::to_value(&initial).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        Ok(Self {
            value: initial,
            snapshot,
        })
    }

    /// Borrow the current state immutably.
    pub fn get(&self) -> &S {
        &self.value
    }

    /// Borrow the current state mutably (for action handlers).
    pub fn get_mut(&mut self) -> &mut S {
        &mut self.value
    }

    /// Take a snapshot of the current state (call *before* a handler mutates it).
    pub fn take_snapshot(&mut self) -> Result<()> {
        self.snapshot =
            serde_json::to_value(&self.value).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        Ok(())
    }

    /// Compare the current state against the last snapshot and return
    /// the list of dot-separated paths that changed.
    ///
    /// This is the core mechanism: handlers just do `state.count += 1`,
    /// and we diff before/after to find `["count"]`.
    ///
    /// Delegates to the canonical [`hypen_engine::diff_paths`] — there is
    /// exactly one implementation of this algorithm across all Hypen
    /// SDKs, and it lives in the engine crate.
    pub fn changed_paths(&self) -> Result<Vec<String>> {
        let current =
            serde_json::to_value(&self.value).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        Ok(hypen_engine::diff_paths(&self.snapshot, &current)
            .into_iter()
            .map(|e| e.path)
            .collect())
    }

    /// Get the current state as a JSON value (for the engine).
    pub fn to_json(&self) -> Result<Value> {
        serde_json::to_value(&self.value).map_err(|e| SdkError::StateSerde(e.to_string()))
    }

    /// Build a JSON patch object containing only the changed key-value pairs.
    ///
    /// For root-level fields, the full new subtree is included (matching
    /// the pre-existing SDK contract). Deeper changes are serialized as
    /// flat dotted paths in the same object.
    pub fn diff_patch(&self) -> Result<Value> {
        let current =
            serde_json::to_value(&self.value).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        let mut patch = serde_json::Map::new();
        for entry in hypen_engine::diff_paths(&self.snapshot, &current) {
            // Top-level field: include the whole new subtree under that
            // key so the engine can replace it atomically.
            if !entry.path.contains('.') {
                if let Value::Object(current_map) = &current {
                    if let Some(new_subtree) = current_map.get(&entry.path) {
                        patch.insert(entry.path, new_subtree.clone());
                        continue;
                    }
                }
            }
            patch.insert(entry.path, entry.new_value);
        }
        Ok(Value::Object(patch))
    }
}

// ---------------------------------------------------------------------------
// __hypen_bind two-way binding helpers
// ---------------------------------------------------------------------------
//
// `__hypen_bind` is the engine-level reserved action name used by renderers
// to push form-control values back into module state. The renderer dispatches
// `__hypen_bind` with `{path, value}` payload; the SDK writes that value at
// the dotted path inside the typed state via `hypen_engine::path_set`.
//
// See ENGINE_CONTRACT.md §13 for the cross-SDK contract.

/// Apply a `__hypen_bind` payload to a typed state value via JSON round-trip.
///
/// Serializes `current` to JSON, calls [`hypen_engine::path_set`], and
/// deserializes back to `S`. Errors out if the resulting JSON doesn't
/// fit the type.
pub(crate) fn apply_bind<S: State>(current: &S, path: &str, value: Value) -> Result<S> {
    let mut json = serde_json::to_value(current).map_err(|e| SdkError::StateSerde(e.to_string()))?;
    hypen_engine::path_set(&mut json, path, value);
    serde_json::from_value(json).map_err(|e| {
        SdkError::StateSerde(format!("__hypen_bind apply at '{path}': {e}"))
    })
}

/// JSON-side variant of [`apply_bind`] for the remote session. Returns
/// `None` if the bind would produce a shape `S` cannot accept (silently
/// dropped, mirroring TS/JS proxy semantics).
pub(crate) fn apply_bind_to_json<S: State>(
    state_json: &Value,
    path: &str,
    value: Value,
) -> Option<Value> {
    let mut new_json = state_json.clone();
    hypen_engine::path_set(&mut new_json, path, value);
    let typed: S = serde_json::from_value(new_json.clone()).ok()?;
    serde_json::to_value(&typed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
    struct TestState {
        count: i32,
        name: String,
        items: Vec<String>,
    }

    #[test]
    fn test_diff_no_change() {
        let container = StateContainer::new(TestState {
            count: 0,
            name: "Alice".into(),
            items: vec![],
        })
        .unwrap();

        let paths = container.changed_paths().unwrap();
        assert!(paths.is_empty());
    }

    #[test]
    fn test_diff_scalar_change() {
        let mut container = StateContainer::new(TestState {
            count: 0,
            name: "Alice".into(),
            items: vec![],
        })
        .unwrap();

        container.take_snapshot().unwrap();
        container.get_mut().count = 42;

        let paths = container.changed_paths().unwrap();
        assert_eq!(paths, vec!["count"]);
    }

    #[test]
    fn test_diff_multiple_changes() {
        let mut container = StateContainer::new(TestState {
            count: 0,
            name: "Alice".into(),
            items: vec![],
        })
        .unwrap();

        container.take_snapshot().unwrap();
        container.get_mut().count = 10;
        container.get_mut().name = "Bob".into();

        let mut paths = container.changed_paths().unwrap();
        paths.sort();
        assert_eq!(paths, vec!["count", "name"]);
    }

    #[test]
    fn test_diff_array_change() {
        let mut container = StateContainer::new(TestState {
            count: 0,
            name: "Alice".into(),
            items: vec!["a".into()],
        })
        .unwrap();

        container.take_snapshot().unwrap();
        container.get_mut().items.push("b".into());

        let paths = container.changed_paths().unwrap();
        assert!(paths.contains(&"items.1".to_string()));
    }

    #[test]
    fn test_diff_nested_struct() {
        #[derive(Clone, Default, Serialize, Deserialize)]
        struct Nested {
            user: User,
            count: i32,
        }

        #[derive(Clone, Default, Serialize, Deserialize)]
        struct User {
            name: String,
            age: i32,
        }

        let mut container = StateContainer::new(Nested {
            user: User {
                name: "Alice".into(),
                age: 30,
            },
            count: 0,
        })
        .unwrap();

        container.take_snapshot().unwrap();
        container.get_mut().user.age = 31;

        let paths = container.changed_paths().unwrap();
        assert_eq!(paths, vec!["user.age"]);
    }

    #[test]
    fn test_diff_delegates_to_engine() {
        // Smoke-test that `changed_paths` routes through the engine's
        // canonical implementation. The deep coverage lives in the
        // engine crate (hypen_engine::portable::diff).
        let old = json!({"a": 1, "b": {"c": 2, "d": 3}});
        let new = json!({"a": 1, "b": {"c": 99, "d": 3}, "e": true});
        let paths: Vec<String> = hypen_engine::diff_paths(&old, &new)
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert!(paths.contains(&"b.c".to_string()));
        assert!(paths.contains(&"e".to_string()));
        assert!(!paths.contains(&"a".to_string()));
        assert!(!paths.contains(&"b.d".to_string()));
    }

    #[test]
    fn test_diff_patch_output() {
        let mut container = StateContainer::new(TestState {
            count: 0,
            name: "Alice".into(),
            items: vec![],
        })
        .unwrap();

        container.take_snapshot().unwrap();
        container.get_mut().count = 5;

        let patch = container.diff_patch().unwrap();
        assert_eq!(patch, json!({"count": 5}));
    }

    #[test]
    fn test_to_json() {
        let container = StateContainer::new(TestState {
            count: 42,
            name: "Bob".into(),
            items: vec!["x".into()],
        })
        .unwrap();

        let json = container.to_json().unwrap();
        assert_eq!(json["count"], 42);
        assert_eq!(json["name"], "Bob");
    }
}
