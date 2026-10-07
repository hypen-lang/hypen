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
    reserved: serde_json::Map<String, Value>,
}

impl<S: State> StateContainer<S> {
    /// Create a new container, serializing the initial state to JSON.
    pub fn new(initial: S) -> Result<Self> {
        let snapshot =
            serde_json::to_value(&initial).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        Ok(Self {
            value: initial,
            reserved: reserved_fields(&snapshot),
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
        self.snapshot = self.to_json()?;
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
        let current = self.to_json()?;
        Ok(hypen_engine::diff_paths(&self.snapshot, &current)
            .into_iter()
            .map(|e| e.path)
            .collect())
    }

    /// Get the current state as a JSON value (for the engine).
    pub fn to_json(&self) -> Result<Value> {
        let mut json =
            serde_json::to_value(&self.value).map_err(|e| SdkError::StateSerde(e.to_string()))?;
        if let Some(map) = json.as_object_mut() {
            for (key, value) in &self.reserved {
                map.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        Ok(json)
    }

    pub(crate) fn replace_json(&mut self, json: Value) -> Result<()> {
        let value = decode_state(&json)?;
        self.reserved = reserved_fields(&json);
        self.value = value;
        Ok(())
    }

    /// Build a JSON patch object that the engine's `update_state`
    /// (object-merge semantics) can apply correctly.
    ///
    /// We roll every changed path up to its **root** segment and emit
    /// the whole new subtree under that root. The engine's `merge_json`
    /// only understands literal top-level keys — emitting a dotted key
    /// like `"tabs.0"` would create a sibling field, not write through
    /// to `state.tabs[0]`, which silently left arrays unchanged on
    /// growth/replace. Rolling up to `"tabs": [...]` makes the engine
    /// state actually reflect what the SDK-side state holds.
    ///
    /// (Sparse path-level updates exist as
    /// `Engine::update_state_sparse`; this method is for the
    /// object-merge variant used by `sync_state_to_engine`.)
    pub fn diff_patch(&self) -> Result<Value> {
        let current = self.to_json()?;
        let mut patch = serde_json::Map::new();
        let Value::Object(current_map) = &current else {
            return Ok(Value::Object(patch));
        };
        for entry in hypen_engine::diff_paths(&self.snapshot, &current) {
            let root = match entry.path.split_once('.') {
                Some((head, _)) => head,
                None => entry.path.as_str(),
            };
            if patch.contains_key(root) {
                continue;
            }
            if let Some(new_subtree) = current_map.get(root) {
                patch.insert(root.to_string(), new_subtree.clone());
            }
        }
        Ok(Value::Object(patch))
    }
}

fn reserved_fields(json: &Value) -> serde_json::Map<String, Value> {
    json.as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| k.starts_with("__"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Typed models need not declare runtime-owned state (even with deny_unknown_fields).
pub(crate) fn decode_state<S: State>(json: &Value) -> Result<S> {
    if let Ok(value) = serde_json::from_value(json.clone()) {
        return Ok(value);
    }
    let mut user = json.clone();
    if let Some(map) = user.as_object_mut() {
        map.retain(|key, _| !key.starts_with("__"));
    }
    serde_json::from_value(user).map_err(|e| SdkError::StateSerde(e.to_string()))
}

pub(crate) fn encode_state<S: State>(state: &S, previous: &Value) -> Result<Value> {
    let mut json = serde_json::to_value(state).map_err(|e| SdkError::StateSerde(e.to_string()))?;
    if let Some(map) = json.as_object_mut() {
        for (key, value) in reserved_fields(previous) {
            map.entry(key).or_insert(value);
        }
    }
    Ok(json)
}

/// Calculate and validate the entire outcome before committing either axis/list.
pub(crate) fn apply_dnd_to_json<S: State>(
    current: &Value,
    action: &str,
    payload: Option<&Value>,
) -> Result<Value> {
    use hypen_engine::action_routing::safe_state_path;
    let invalid = || SdkError::StateSerde(format!("{action}: invalid or incompatible outcome"));
    let p = payload.and_then(Value::as_object).ok_or_else(invalid)?;
    let mut next = current.clone();
    let mut written = Vec::new();
    if action == "__hypen_reorder" {
        let from_path = p
            .get("fromPath")
            .or_else(|| p.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let to_path = p.get("toPath").and_then(Value::as_str).unwrap_or(from_path);
        let from = p
            .get("from")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(invalid)?;
        let to = p
            .get("to")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(invalid)?;
        if !safe_state_path(from_path) || !safe_state_path(to_path) {
            return Err(invalid());
        }
        if !hypen_engine::path_move(&mut next, from_path, from, to_path, to) {
            return Ok(current.clone());
        }
    } else if action == "__hypen_pin" {
        let path = p
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| safe_state_path(p))
            .ok_or_else(invalid)?;
        for (axis, field) in [("x", "xKey"), ("y", "yKey")] {
            let key = p
                .get(field)
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
                .unwrap_or(axis);
            if !safe_state_path(key) || key.contains('.') {
                return Err(invalid());
            }
            let value = p
                .get(axis)
                .filter(|v| v.as_f64().is_some_and(f64::is_finite))
                .ok_or_else(invalid)?
                .clone();
            let path = format!("{path}.{key}");
            hypen_engine::path_set(&mut next, &path, value.clone());
            written.push((path, value));
        }
    } else {
        return Err(invalid());
    }
    let typed: S = decode_state(&next)?;
    let encoded = encode_state(&typed, &next)?;
    for (path, value) in written {
        if hypen_engine::path_get(&encoded, &path) != Some(value) {
            return Err(invalid());
        }
    }
    Ok(encoded)
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

/// Apply a binding through JSON while retaining runtime-owned state. Returns
/// `None` when the resulting value cannot be represented by the typed model.
pub(crate) fn apply_bind_to_json<S: State>(
    state_json: &Value,
    path: &str,
    value: Value,
) -> Option<Value> {
    let mut new_json = state_json.clone();
    hypen_engine::path_set(&mut new_json, path, value);
    let typed: S = decode_state(&new_json).ok()?;
    encode_state(&typed, &new_json).ok()
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
    fn diff_patch_rolls_up_growing_vec_to_root_subtree() {
        // Regression: when a Vec field grew from [] → [item], the diff
        // produced path "items.0" and the old diff_patch emitted a
        // literal `"items.0"` key. The engine's merge_json then inserted
        // that key as a SIBLING of `items`, leaving `state.items` as
        // `[]` from the engine's perspective — ForEach iterating over
        // `@state.items` rendered nothing and `length(state.items)` was
        // 0 despite the SDK-side Vec being populated.
        let mut container = StateContainer::new(TestState {
            count: 0,
            name: "x".into(),
            items: vec![],
        })
        .unwrap();
        container.take_snapshot().unwrap();
        container.get_mut().items.push("first".into());

        let patch = container.diff_patch().unwrap();
        assert_eq!(
            patch,
            json!({"items": ["first"]}),
            "growing vec must emit whole `items` subtree, not `items.0`",
        );
    }

    #[test]
    fn diff_patch_rolls_up_nested_object_change_to_root() {
        // Same principle: a deep object change like `user.profile.name`
        // becomes `{"user": <whole user subtree>}` rather than
        // `{"user.profile.name": "..."}`, because merge_json only
        // honours literal top-level keys.
        #[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
        struct Profile {
            name: String,
        }
        #[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
        struct User {
            profile: Profile,
            age: i32,
        }
        #[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
        struct S {
            user: User,
        }

        let mut container = StateContainer::new(S {
            user: User {
                profile: Profile { name: "old".into() },
                age: 30,
            },
        })
        .unwrap();
        container.take_snapshot().unwrap();
        container.get_mut().user.profile.name = "new".into();

        let patch = container.diff_patch().unwrap();
        assert_eq!(
            patch,
            json!({"user": {"profile": {"name": "new"}, "age": 30}}),
        );
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

#[cfg(test)]
mod dnd_regressions {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Clone, Default, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StrictState {
        count: i32,
        items: Vec<String>,
    }

    #[test]
    fn reserved_pin_survives_typed_mutation_snapshot_and_restore() {
        let mut state = StateContainer::new(StrictState {
            count: 0,
            items: vec!["a".into(), "b".into()],
        })
        .unwrap();
        state.take_snapshot().unwrap();
        let next = apply_dnd_to_json::<StrictState>(
            &state.to_json().unwrap(),
            "__hypen_pin",
            Some(&json!({"path":"__dnd.board.n1","x":0.5,"y":0.25,"xKey":"left","yKey":"top"})),
        )
        .unwrap();
        state.replace_json(next).unwrap();
        assert_eq!(
            state.diff_patch().unwrap(),
            json!({"__dnd":{"board":{"n1":{"left":0.5,"top":0.25}}}})
        );
        state.take_snapshot().unwrap();
        state.get_mut().count += 1;
        assert_eq!(state.changed_paths().unwrap(), vec!["count"]);
        let snapshot = state.to_json().unwrap();
        let mut restored = StateContainer::new(StrictState::default()).unwrap();
        restored.replace_json(snapshot.clone()).unwrap();
        assert_eq!(restored.to_json().unwrap(), snapshot);
    }

    #[test]
    fn bound_pin_rejects_missing_fields_without_committing_either_axis() {
        let before = json!({"count":0,"items":["a","b"]});
        assert!(apply_dnd_to_json::<StrictState>(
            &before,
            "__hypen_pin",
            Some(&json!({"path":"point","x":3,"y":4}))
        )
        .is_err());
        let after = apply_dnd_to_json::<StrictState>(
            &before,
            "__hypen_reorder",
            Some(&json!({"path":"items","from":0,"to":1})),
        )
        .unwrap();
        assert_eq!(after["items"], json!(["b", "a"]));
    }
}
