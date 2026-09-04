use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Metadata describing a stateful module.
///
/// A module is the unit of state and behavior in Hypen. It declares which
/// actions it handles, which state keys it exposes, and optional persistence
/// or versioning settings.
///
/// Modules are instantiated as [`ModuleInstance`] which holds the live state.
///
/// # Example
///
/// ```rust
/// use hypen_engine::Module;
///
/// let module = Module::new("Counter")
///     .with_actions(vec!["increment".into(), "decrement".into()])
///     .with_state_keys(vec!["count".into()]);
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    /// Module name (e.g. `"Counter"`, `"ProfilePage"`)
    pub name: String,

    /// Action names this module handles (e.g. `["increment", "decrement"]`)
    pub actions: Vec<String>,

    /// Top-level state keys this module exposes (e.g. `["count", "user"]`)
    pub state_keys: Vec<String>,

    /// Whether state should be persisted across sessions
    pub persist: bool,

    /// Optional schema version for state migration
    pub version: Option<u32>,
}

impl Module {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            actions: Vec::new(),
            state_keys: Vec::new(),
            persist: false,
            version: None,
        }
    }

    pub fn with_actions(mut self, actions: Vec<String>) -> Self {
        self.actions = actions;
        self
    }

    pub fn with_state_keys(mut self, state_keys: Vec<String>) -> Self {
        self.state_keys = state_keys;
        self
    }

    pub fn with_persist(mut self, persist: bool) -> Self {
        self.persist = persist;
        self
    }

    pub fn with_version(mut self, version: u32) -> Self {
        self.version = Some(version);
        self
    }
}

/// Lifecycle hooks for a module.
///
/// Implement this trait to receive notifications when a module is created,
/// destroyed, or when its state changes. This is primarily used by SDK
/// implementations to bridge engine lifecycle events to host language callbacks.
pub trait ModuleLifecycle {
    /// Called when the module is first mounted.
    fn on_created(&mut self);

    /// Called when the module is unmounted and about to be dropped.
    fn on_destroyed(&mut self);

    /// Called when state is updated from the host.
    fn on_state_changed(&mut self, state: serde_json::Value);
}

/// Callback type for lifecycle events
pub type LifecycleCallback = Box<dyn Fn() + Send + Sync>;

/// A live module instance holding the current state and lifecycle callbacks.
///
/// State is wrapped in `Arc` for O(1) clone performance — critical because
/// state is accessed on every render cycle. With `Arc`, "cloning" is just a
/// reference count increment instead of a deep copy.
///
/// # Lifecycle
///
/// ```text
/// new() → mount() → [update_state()...] → unmount()
///          ↑                                    |
///          └────────────────────────────────────┘
///                   (can re-mount)
/// ```
///
/// Mount/unmount are idempotent — calling `mount()` twice only fires `on_created` once.
pub struct ModuleInstance {
    /// Module metadata (name, action names, state keys)
    pub module: Module,

    /// Current state snapshot (Arc-wrapped for O(1) clone)
    state: Arc<serde_json::Value>,

    /// Whether the module is currently mounted
    pub mounted: bool,

    /// Callback for when module is created
    on_created: Option<LifecycleCallback>,

    /// Callback for when module is destroyed
    on_destroyed: Option<LifecycleCallback>,
}

impl ModuleInstance {
    pub fn new(module: Module, initial_state: serde_json::Value) -> Self {
        Self {
            module,
            state: Arc::new(initial_state),
            mounted: false,
            on_created: None,
            on_destroyed: None,
        }
    }

    /// Build a `ModuleInstance` from raw configuration fields.
    ///
    /// Convenience constructor for FFI bindings (WASM, WASI, UniFFI) that all
    /// receive a name + actions + state keys + initial state and need to wire
    /// them into a `Module` + `ModuleInstance` pair.
    pub fn from_config(
        name: &str,
        actions: Vec<String>,
        state_keys: Vec<String>,
        initial_state: serde_json::Value,
    ) -> Self {
        let module = Module::new(name)
            .with_actions(actions)
            .with_state_keys(state_keys);
        Self::new(module, initial_state)
    }

    /// Set the on_created lifecycle callback
    pub fn set_on_created<F>(&mut self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.on_created = Some(Box::new(callback));
    }

    /// Set the on_destroyed lifecycle callback
    pub fn set_on_destroyed<F>(&mut self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.on_destroyed = Some(Box::new(callback));
    }

    /// Mount the module (call on_created)
    pub fn mount(&mut self) {
        if !self.mounted {
            self.mounted = true;
            // Call on_created lifecycle hook if registered
            if let Some(ref callback) = self.on_created {
                callback();
            }
        }
    }

    /// Unmount the module (call on_destroyed)
    pub fn unmount(&mut self) {
        if self.mounted {
            // Call on_destroyed lifecycle hook if registered
            if let Some(ref callback) = self.on_destroyed {
                callback();
            }
            self.mounted = false;
        }
    }

    /// Update state from a patch. Returns `true` when the merge actually
    /// altered the state tree.
    ///
    /// Uses Arc::make_mut for copy-on-write semantics: if this is the only
    /// reference, mutates in place; otherwise clones first. Callers must not
    /// hold a second `Arc` (e.g. a `get_state_shared()` snapshot) across this
    /// call — that forces a deep clone of the whole tree on every update.
    /// Change detection is done at the written leaves instead, so no snapshot
    /// is needed.
    pub fn update_state(&mut self, patch: serde_json::Value) -> bool {
        // Arc::make_mut provides copy-on-write: clones only if shared
        let state = Arc::make_mut(&mut self.state);
        merge_json(state, patch)
    }

    /// Update state from sparse path-value pairs. Returns `true` when at
    /// least one path actually wrote a different value.
    /// This is more efficient than sending the full state when only a few paths changed
    ///
    /// Uses Arc::make_mut for copy-on-write semantics (see [`update_state`]
    /// for the no-snapshot requirement).
    pub fn update_state_sparse(&mut self, paths: &[String], values: &serde_json::Value) -> bool {
        // values is expected to be an object mapping paths to their new values
        let serde_json::Value::Object(map) = values else {
            return false;
        };
        // Only get mutable access if we have paths to update
        if !paths.iter().any(|p| map.contains_key(p)) {
            return false;
        }
        let state = Arc::make_mut(&mut self.state);
        let mut changed = false;
        for path in paths {
            if let Some(new_value) = map.get(path) {
                changed |= set_value_at_path(state, path, new_value);
            }
        }
        changed
    }

    /// Get a reference to the current state
    ///
    /// For read-only access without cloning. Prefer this over `get_state_shared()`
    /// when you don't need to store the state beyond the current scope.
    pub fn get_state(&self) -> &serde_json::Value {
        &self.state
    }

    /// Get a shared reference to the current state (O(1) clone)
    ///
    /// Use this for the render hot path where state needs to be passed around
    /// without deep copying. Cloning the Arc is just a reference count increment.
    pub fn get_state_shared(&self) -> Arc<serde_json::Value> {
        Arc::clone(&self.state)
    }
}

/// Deep merge two JSON values.
///
/// Returns `true` when the merge actually changed `target`. Detection is done
/// at the leaves the patch actually writes, so the cost is bounded by the
/// patch size rather than by the size of the whole state tree — no snapshot
/// or whole-tree comparison is required.
fn merge_json(target: &mut serde_json::Value, source: serde_json::Value) -> bool {
    use serde_json::Value;

    match (target, source) {
        (Value::Object(target_map), Value::Object(source_map)) => {
            let mut changed = false;
            for (key, value) in source_map {
                if let Some(target_value) = target_map.get_mut(&key) {
                    changed |= merge_json(target_value, value);
                } else {
                    target_map.insert(key, value);
                    changed = true;
                }
            }
            changed
        }
        (target, source) => {
            if *target == source {
                false
            } else {
                *target = source;
                true
            }
        }
    }
}

/// Set a value at a dot-separated path (e.g., "user.profile.name")
/// Creates intermediate objects if they don't exist.
///
/// Returns `true` when the write actually changed something — either the
/// final leaf differed from `value`, or an intermediate segment had to be
/// auto-vivified / an array grown.
fn set_value_at_path(target: &mut serde_json::Value, path: &str, value: &serde_json::Value) -> bool {
    use serde_json::Value;

    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() {
        return false;
    }

    let mut changed = false;
    let mut current = target;

    // Navigate to the parent of the final key
    for part in &parts[..parts.len() - 1] {
        // Try to parse as array index first
        if let Ok(index) = part.parse::<usize>() {
            if let Value::Array(arr) = current {
                // Extend array if needed
                while arr.len() <= index {
                    arr.push(Value::Null);
                    changed = true;
                }
                current = &mut arr[index];
                continue;
            }
        }

        // Otherwise treat as object key
        if !current.is_object() {
            *current = Value::Object(serde_json::Map::new());
            changed = true;
        }

        if let Value::Object(map) = current {
            if !map.contains_key(*part) {
                map.insert(part.to_string(), Value::Object(serde_json::Map::new()));
                changed = true;
            }
            current = map.get_mut(*part).unwrap();
        }
    }

    // Set the final value
    let final_key = parts[parts.len() - 1];

    // Try to parse as array index
    if let Ok(index) = final_key.parse::<usize>() {
        if let Value::Array(arr) = current {
            while arr.len() <= index {
                arr.push(Value::Null);
                changed = true;
            }
            if arr[index] != *value {
                arr[index] = value.clone();
                changed = true;
            }
            return changed;
        }
    }

    // Set as object property
    if !current.is_object() {
        *current = Value::Object(serde_json::Map::new());
        changed = true;
    }

    if let Value::Object(map) = current {
        match map.get_mut(final_key) {
            Some(slot) => {
                if *slot != *value {
                    *slot = value.clone();
                    changed = true;
                }
            }
            None => {
                map.insert(final_key.to_string(), value.clone());
                changed = true;
            }
        }
    }

    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_merge_json() {
        let mut target = json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        });

        let patch = json!({
            "user": {
                "age": 31
            }
        });

        merge_json(&mut target, patch);

        assert_eq!(target["user"]["name"], "Alice");
        assert_eq!(target["user"]["age"], 31);
    }

    #[test]
    fn test_lifecycle_on_created_callback() {
        use std::sync::{Arc, Mutex};

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        // Track if callback was called
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();

        instance.set_on_created(move || {
            *called_clone.lock().unwrap() = true;
        });

        // Mount should call on_created
        assert!(!*called.lock().unwrap());
        instance.mount();
        assert!(*called.lock().unwrap());
        assert!(instance.mounted);
    }

    #[test]
    fn test_lifecycle_on_destroyed_callback() {
        use std::sync::{Arc, Mutex};

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();

        instance.set_on_destroyed(move || {
            *called_clone.lock().unwrap() = true;
        });

        // First mount the module
        instance.mount();
        assert!(instance.mounted);

        // Unmount should call on_destroyed
        assert!(!*called.lock().unwrap());
        instance.unmount();
        assert!(*called.lock().unwrap());
        assert!(!instance.mounted);
    }

    #[test]
    fn test_lifecycle_callbacks_not_called_when_not_set() {
        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        // Should not panic when callbacks are not set
        instance.mount();
        assert!(instance.mounted);

        instance.unmount();
        assert!(!instance.mounted);
    }

    #[test]
    fn test_lifecycle_mount_idempotent() {
        use std::sync::{Arc, Mutex};

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        let call_count = Arc::new(Mutex::new(0));
        let call_count_clone = call_count.clone();

        instance.set_on_created(move || {
            *call_count_clone.lock().unwrap() += 1;
        });

        // First mount
        instance.mount();
        assert_eq!(*call_count.lock().unwrap(), 1);

        // Second mount should not call callback again
        instance.mount();
        assert_eq!(*call_count.lock().unwrap(), 1);
    }

    #[test]
    fn test_lifecycle_unmount_idempotent() {
        use std::sync::{Arc, Mutex};

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        let call_count = Arc::new(Mutex::new(0));
        let call_count_clone = call_count.clone();

        instance.set_on_destroyed(move || {
            *call_count_clone.lock().unwrap() += 1;
        });

        // Mount first
        instance.mount();

        // First unmount
        instance.unmount();
        assert_eq!(*call_count.lock().unwrap(), 1);

        // Second unmount should not call callback again
        instance.unmount();
        assert_eq!(*call_count.lock().unwrap(), 1);
    }

    #[test]
    fn test_lifecycle_full_cycle() {
        use std::sync::{Arc, Mutex};

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let mut instance = ModuleInstance::new(module, initial_state);

        let events = Arc::new(Mutex::new(Vec::new()));
        let events_created = events.clone();
        let events_destroyed = events.clone();

        instance.set_on_created(move || {
            events_created.lock().unwrap().push("created");
        });

        instance.set_on_destroyed(move || {
            events_destroyed.lock().unwrap().push("destroyed");
        });

        // Full lifecycle: mount -> unmount -> mount -> unmount
        instance.mount();
        instance.unmount();
        instance.mount();
        instance.unmount();

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0], "created");
        assert_eq!(events[1], "destroyed");
        assert_eq!(events[2], "created");
        assert_eq!(events[3], "destroyed");
    }

    #[test]
    fn test_set_value_at_path_simple() {
        let mut state = json!({
            "count": 0
        });

        set_value_at_path(&mut state, "count", &json!(42));
        assert_eq!(state["count"], 42);
    }

    #[test]
    fn test_set_value_at_path_nested() {
        let mut state = json!({
            "user": {
                "name": "Alice",
                "profile": {
                    "bio": "Developer"
                }
            }
        });

        set_value_at_path(&mut state, "user.profile.bio", &json!("Engineer"));
        assert_eq!(state["user"]["profile"]["bio"], "Engineer");
        // Other values should be unchanged
        assert_eq!(state["user"]["name"], "Alice");
    }

    #[test]
    fn test_set_value_at_path_creates_intermediate() {
        let mut state = json!({});

        set_value_at_path(&mut state, "user.profile.name", &json!("Bob"));
        assert_eq!(state["user"]["profile"]["name"], "Bob");
    }

    #[test]
    fn test_set_value_at_path_array_index() {
        let mut state = json!({
            "items": ["a", "b", "c"]
        });

        set_value_at_path(&mut state, "items.1", &json!("modified"));
        assert_eq!(state["items"][1], "modified");
        assert_eq!(state["items"][0], "a");
        assert_eq!(state["items"][2], "c");
    }

    #[test]
    fn test_update_state_sparse_single_path() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "count": 0,
            "name": "Alice"
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths = vec!["count".to_string()];
        let values = json!({
            "count": 42
        });

        instance.update_state_sparse(&paths, &values);

        assert_eq!(instance.get_state()["count"], 42);
        assert_eq!(instance.get_state()["name"], "Alice"); // Unchanged
    }

    #[test]
    fn test_update_state_sparse_nested_path() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "user": {
                "name": "Alice",
                "age": 30
            },
            "settings": {
                "theme": "dark"
            }
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths = vec!["user.age".to_string()];
        let values = json!({
            "user.age": 31
        });

        instance.update_state_sparse(&paths, &values);

        assert_eq!(instance.get_state()["user"]["age"], 31);
        assert_eq!(instance.get_state()["user"]["name"], "Alice"); // Unchanged
        assert_eq!(instance.get_state()["settings"]["theme"], "dark"); // Unchanged
    }

    #[test]
    fn test_update_state_sparse_multiple_paths() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "count": 0,
            "user": {
                "name": "Alice"
            }
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths = vec!["count".to_string(), "user.name".to_string()];
        let values = json!({
            "count": 100,
            "user.name": "Bob"
        });

        instance.update_state_sparse(&paths, &values);

        assert_eq!(instance.get_state()["count"], 100);
        assert_eq!(instance.get_state()["user"]["name"], "Bob");
    }

    // ============ Edge Case Tests ============

    #[test]
    fn test_set_value_at_path_empty_path() {
        let mut state = json!({"count": 0});
        // Empty path should do nothing
        set_value_at_path(&mut state, "", &json!(42));
        assert_eq!(state["count"], 0);
    }

    #[test]
    fn test_set_value_at_path_null_value() {
        let mut state = json!({
            "user": {
                "name": "Alice",
                "email": "alice@example.com"
            }
        });

        set_value_at_path(&mut state, "user.email", &json!(null));
        assert_eq!(state["user"]["email"], serde_json::Value::Null);
        assert_eq!(state["user"]["name"], "Alice"); // Unchanged
    }

    #[test]
    fn test_set_value_at_path_type_change() {
        let mut state = json!({
            "data": "string value"
        });

        // Change string to object
        set_value_at_path(&mut state, "data", &json!({"nested": true}));
        assert_eq!(state["data"]["nested"], true);

        // Change object to array
        set_value_at_path(&mut state, "data", &json!([1, 2, 3]));
        assert_eq!(state["data"][0], 1);

        // Change array to number
        set_value_at_path(&mut state, "data", &json!(42));
        assert_eq!(state["data"], 42);
    }

    #[test]
    fn test_set_value_at_path_deeply_nested() {
        let mut state = json!({});

        // Create deeply nested path (6 levels deep)
        set_value_at_path(&mut state, "a.b.c.d.e.f", &json!("deep value"));
        assert_eq!(state["a"]["b"]["c"]["d"]["e"]["f"], "deep value");
    }

    #[test]
    fn test_set_value_at_path_nested_array_object() {
        let mut state = json!({
            "users": [
                {"name": "Alice", "tags": ["admin"]},
                {"name": "Bob", "tags": ["user"]}
            ]
        });

        // Update nested object within array
        set_value_at_path(&mut state, "users.1.name", &json!("Robert"));
        assert_eq!(state["users"][1]["name"], "Robert");
        assert_eq!(state["users"][0]["name"], "Alice"); // Unchanged

        // Update nested array within array element
        set_value_at_path(&mut state, "users.0.tags.0", &json!("superadmin"));
        assert_eq!(state["users"][0]["tags"][0], "superadmin");
    }

    #[test]
    fn test_set_value_at_path_extend_array() {
        let mut state = json!({
            "items": ["a", "b"]
        });

        // Setting index 5 should extend array with nulls
        set_value_at_path(&mut state, "items.5", &json!("extended"));
        assert_eq!(state["items"].as_array().unwrap().len(), 6);
        assert_eq!(state["items"][5], "extended");
        assert_eq!(state["items"][2], serde_json::Value::Null);
        assert_eq!(state["items"][3], serde_json::Value::Null);
        assert_eq!(state["items"][4], serde_json::Value::Null);
    }

    #[test]
    fn test_set_value_at_path_overwrite_primitive_with_nested() {
        let mut state = json!({
            "config": 42
        });

        // Trying to set a nested path where parent is a primitive
        // Should convert primitive to object
        set_value_at_path(&mut state, "config.nested.value", &json!("test"));
        assert_eq!(state["config"]["nested"]["value"], "test");
    }

    #[test]
    fn test_set_value_at_path_boolean_values() {
        let mut state = json!({
            "flags": {
                "enabled": true,
                "visible": false
            }
        });

        set_value_at_path(&mut state, "flags.enabled", &json!(false));
        set_value_at_path(&mut state, "flags.visible", &json!(true));
        assert_eq!(state["flags"]["enabled"], false);
        assert_eq!(state["flags"]["visible"], true);
    }

    #[test]
    fn test_set_value_at_path_float_values() {
        let mut state = json!({
            "coordinates": {
                "lat": 0.0,
                "lng": 0.0
            }
        });

        set_value_at_path(&mut state, "coordinates.lat", &json!(37.7749));
        set_value_at_path(&mut state, "coordinates.lng", &json!(-122.4194));

        // Use approximate comparison for floats
        let lat = state["coordinates"]["lat"].as_f64().unwrap();
        let lng = state["coordinates"]["lng"].as_f64().unwrap();
        assert!((lat - 37.7749).abs() < 0.0001);
        assert!((lng - (-122.4194)).abs() < 0.0001);
    }

    #[test]
    fn test_update_state_sparse_empty_paths() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "count": 0
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths: Vec<String> = vec![];
        let values = json!({});

        // Should not panic or modify state
        instance.update_state_sparse(&paths, &values);
        assert_eq!(instance.get_state()["count"], 0);
    }

    #[test]
    fn test_update_state_sparse_path_not_in_values() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "count": 0,
            "name": "Alice"
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        // Path is specified but not in values - should be skipped
        let paths = vec!["count".to_string(), "missing".to_string()];
        let values = json!({
            "count": 42
            // "missing" not provided
        });

        instance.update_state_sparse(&paths, &values);
        assert_eq!(instance.get_state()["count"], 42);
        assert_eq!(instance.get_state()["name"], "Alice");
    }

    #[test]
    fn test_update_state_sparse_invalid_values_type() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "count": 0
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        // values is not an object - should not crash, just skip
        let paths = vec!["count".to_string()];
        let values = json!("not an object");

        instance.update_state_sparse(&paths, &values);
        // State should remain unchanged
        assert_eq!(instance.get_state()["count"], 0);
    }

    #[test]
    fn test_update_state_sparse_array_values() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "items": []
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths = vec!["items".to_string()];
        let values = json!({
            "items": ["a", "b", "c"]
        });

        instance.update_state_sparse(&paths, &values);
        assert_eq!(instance.get_state()["items"], json!(["a", "b", "c"]));
    }

    #[test]
    fn test_update_state_sparse_complex_nested_update() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "app": {
                "ui": {
                    "theme": "light",
                    "sidebar": {
                        "collapsed": false,
                        "width": 250
                    }
                },
                "data": {
                    "users": [],
                    "cache": {}
                }
            }
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        let paths = vec![
            "app.ui.theme".to_string(),
            "app.ui.sidebar.collapsed".to_string(),
            "app.data.users".to_string(),
        ];
        let values = json!({
            "app.ui.theme": "dark",
            "app.ui.sidebar.collapsed": true,
            "app.data.users": [{"id": 1, "name": "Alice"}]
        });

        instance.update_state_sparse(&paths, &values);

        assert_eq!(instance.get_state()["app"]["ui"]["theme"], "dark");
        assert_eq!(
            instance.get_state()["app"]["ui"]["sidebar"]["collapsed"],
            true
        );
        assert_eq!(instance.get_state()["app"]["ui"]["sidebar"]["width"], 250); // Unchanged
        assert_eq!(
            instance.get_state()["app"]["data"]["users"][0]["name"],
            "Alice"
        );
        assert!(instance.get_state()["app"]["data"]["cache"].is_object()); // Unchanged
    }

    #[test]
    fn test_update_state_sparse_preserves_sibling_keys() {
        let module = Module::new("TestModule");
        let initial_state = json!({
            "user": {
                "name": "Alice",
                "email": "alice@example.com",
                "profile": {
                    "bio": "Developer",
                    "avatar": "alice.png",
                    "social": {
                        "twitter": "@alice",
                        "github": "alice"
                    }
                }
            }
        });
        let mut instance = ModuleInstance::new(module, initial_state);

        // Only update one deeply nested field
        let paths = vec!["user.profile.social.twitter".to_string()];
        let values = json!({
            "user.profile.social.twitter": "@alice_new"
        });

        instance.update_state_sparse(&paths, &values);

        // Verify updated field
        assert_eq!(
            instance.get_state()["user"]["profile"]["social"]["twitter"],
            "@alice_new"
        );

        // Verify all sibling fields are unchanged
        assert_eq!(instance.get_state()["user"]["name"], "Alice");
        assert_eq!(instance.get_state()["user"]["email"], "alice@example.com");
        assert_eq!(instance.get_state()["user"]["profile"]["bio"], "Developer");
        assert_eq!(
            instance.get_state()["user"]["profile"]["avatar"],
            "alice.png"
        );
        assert_eq!(
            instance.get_state()["user"]["profile"]["social"]["github"],
            "alice"
        );
    }
}
