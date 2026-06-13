//! Dotted-path JSON operations.
//!
//! Four pure functions over `serde_json::Value`:
//!
//! * [`path_get`]   — read the value at a dotted path, `None` if missing
//! * [`path_set`]   — write a value at a dotted path, auto-vivifying
//!                    objects and growing arrays with `null` padding
//! * [`path_has`]   — test for presence
//! * [`path_delete` — remove a key/index; returns `true` if something was removed
//!
//! Numeric segments are interpreted as array indices when the current
//! node is an array; otherwise they're treated as object keys (so
//! `map.0.name` is a valid path into `{"0": {"name": …}}`).
//!
//! Used by `__hypen_bind` (renderer → state) and by every host SDK's
//! `ObservableState` implementation. Centralising here removes four
//! hand-ports of the same auto-vivification semantics.

use serde_json::Value;

/// Read the value at a dotted path. Returns `None` if any segment
/// fails to resolve.
pub fn path_get(value: &Value, path: &str) -> Option<Value> {
    if path.is_empty() {
        return Some(value.clone());
    }
    let mut current = value;
    for part in path.split('.') {
        match current {
            Value::Object(map) => {
                current = map.get(part)?;
            }
            Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

/// Test whether a dotted path resolves to a value.
pub fn path_has(value: &Value, path: &str) -> bool {
    path_get(value, path).is_some()
}

/// Write `new_value` at `path` inside `target`. Intermediate objects
/// are created as needed; arrays are extended with `Value::Null` up to
/// the target index. Numeric segments map to array indices only when
/// the current node is already an array.
///
/// An empty path is a no-op (the caller should replace `target`
/// directly if they want to overwrite the root).
pub fn path_set(target: &mut Value, path: &str, new_value: Value) {
    if path.is_empty() {
        return;
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = target;

    // Walk every segment except the last.
    for part in &parts[..parts.len() - 1] {
        // Array index?
        if let Ok(idx) = part.parse::<usize>() {
            if let Value::Array(arr) = current {
                while arr.len() <= idx {
                    arr.push(Value::Null);
                }
                current = &mut arr[idx];
                continue;
            }
        }
        // Otherwise treat as object key. Auto-vivify.
        if !current.is_object() {
            *current = Value::Object(serde_json::Map::new());
        }
        if let Value::Object(map) = current {
            if !map.contains_key(*part) {
                map.insert(part.to_string(), Value::Object(serde_json::Map::new()));
            }
            current = map.get_mut(*part).unwrap();
        }
    }

    // Final segment.
    let last = parts[parts.len() - 1];
    if let Ok(idx) = last.parse::<usize>() {
        if let Value::Array(arr) = current {
            while arr.len() <= idx {
                arr.push(Value::Null);
            }
            arr[idx] = new_value;
            return;
        }
    }
    if !current.is_object() {
        *current = Value::Object(serde_json::Map::new());
    }
    if let Value::Object(map) = current {
        map.insert(last.to_string(), new_value);
    }
}

/// Remove whatever lives at `path`. Returns `true` if a key/index was
/// actually removed, `false` if the path didn't resolve. Array indices
/// are removed by splicing (the array shrinks by one). Empty path is a
/// no-op that returns `false`.
pub fn path_delete(target: &mut Value, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = target;

    for part in &parts[..parts.len() - 1] {
        if let Ok(idx) = part.parse::<usize>() {
            if let Value::Array(arr) = current {
                if let Some(next) = arr.get_mut(idx) {
                    current = next;
                    continue;
                }
                return false;
            }
        }
        match current {
            Value::Object(map) => match map.get_mut(*part) {
                Some(next) => current = next,
                None => return false,
            },
            _ => return false,
        }
    }

    let last = parts[parts.len() - 1];
    if let Ok(idx) = last.parse::<usize>() {
        if let Value::Array(arr) = current {
            if idx < arr.len() {
                arr.remove(idx);
                return true;
            }
            return false;
        }
    }
    if let Value::Object(map) = current {
        return map.remove(last).is_some();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── path_get ────────────────────────────────────────────────

    #[test]
    fn get_nested_object() {
        let v = json!({"user": {"name": "Alice", "age": 30}});
        assert_eq!(path_get(&v, "user.name"), Some(json!("Alice")));
        assert_eq!(path_get(&v, "user.age"), Some(json!(30)));
    }

    #[test]
    fn get_array_index() {
        let v = json!({"items": ["a", "b", "c"]});
        assert_eq!(path_get(&v, "items.1"), Some(json!("b")));
        assert_eq!(path_get(&v, "items.10"), None);
    }

    #[test]
    fn get_missing_returns_none() {
        let v = json!({"a": 1});
        assert_eq!(path_get(&v, "b"), None);
        assert_eq!(path_get(&v, "a.b"), None); // a is not an object
    }

    #[test]
    fn get_empty_path_returns_root() {
        let v = json!({"a": 1});
        assert_eq!(path_get(&v, ""), Some(v.clone()));
    }

    // ── path_has ────────────────────────────────────────────────

    #[test]
    fn has_matches_get() {
        let v = json!({"user": {"name": "Alice"}});
        assert!(path_has(&v, "user"));
        assert!(path_has(&v, "user.name"));
        assert!(!path_has(&v, "user.age"));
        assert!(!path_has(&v, "other"));
    }

    // ── path_set ────────────────────────────────────────────────

    #[test]
    fn set_creates_intermediate_objects() {
        let mut v = json!({});
        path_set(&mut v, "a.b.c", json!(42));
        assert_eq!(v, json!({"a": {"b": {"c": 42}}}));
    }

    #[test]
    fn set_overwrites_existing() {
        let mut v = json!({"a": 1});
        path_set(&mut v, "a", json!(2));
        assert_eq!(v, json!({"a": 2}));
    }

    #[test]
    fn set_extends_array_with_nulls() {
        let mut v = json!({"items": [1, 2]});
        path_set(&mut v, "items.5", json!("X"));
        assert_eq!(v, json!({"items": [1, 2, null, null, null, "X"]}));
    }

    #[test]
    fn set_numeric_segment_on_object_is_key_not_index() {
        // `{"0": "x"}` is a valid object; a numeric key isn't magically
        // an index unless the parent is already an array.
        let mut v = json!({});
        path_set(&mut v, "0", json!("x"));
        assert_eq!(v, json!({"0": "x"}));
    }

    #[test]
    fn set_past_nine_uses_full_decimal() {
        // Same class of bug as diff_paths had in Go — make sure we
        // don't get cute with character arithmetic anywhere.
        let mut v = json!({"items": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]});
        path_set(&mut v, "items.10", json!("ten"));
        assert_eq!(v["items"], json!([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "ten"]));
    }

    #[test]
    fn set_on_non_object_replaces_with_object() {
        let mut v = json!("scalar");
        path_set(&mut v, "a.b", json!(1));
        assert_eq!(v, json!({"a": {"b": 1}}));
    }

    #[test]
    fn set_empty_path_is_noop() {
        let mut v = json!({"a": 1});
        path_set(&mut v, "", json!(99));
        assert_eq!(v, json!({"a": 1}));
    }

    // ── path_delete ──────────────────────────────────────────────

    #[test]
    fn delete_object_key() {
        let mut v = json!({"a": 1, "b": 2});
        assert!(path_delete(&mut v, "a"));
        assert_eq!(v, json!({"b": 2}));
    }

    #[test]
    fn delete_array_index_splices() {
        let mut v = json!({"items": ["a", "b", "c"]});
        assert!(path_delete(&mut v, "items.1"));
        assert_eq!(v, json!({"items": ["a", "c"]}));
    }

    #[test]
    fn delete_missing_returns_false() {
        let mut v = json!({"a": 1});
        assert!(!path_delete(&mut v, "b"));
        assert!(!path_delete(&mut v, "a.nested"));
        assert_eq!(v, json!({"a": 1}));
    }

    #[test]
    fn delete_nested() {
        let mut v = json!({"user": {"name": "Alice", "age": 30}});
        assert!(path_delete(&mut v, "user.age"));
        assert_eq!(v, json!({"user": {"name": "Alice"}}));
    }

    #[test]
    fn delete_array_out_of_bounds() {
        let mut v = json!({"items": ["a"]});
        assert!(!path_delete(&mut v, "items.5"));
    }
}
