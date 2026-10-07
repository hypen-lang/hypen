//! Dotted-path JSON operations.
//!
//! Six pure functions over `serde_json::Value`:
//!
//! * [`path_get`]   — read the value at a dotted path, `None` if missing
//! * [`path_set`]   — write a value at a dotted path, auto-vivifying
//!                    objects and growing arrays with `null` padding
//! * [`path_has`]   — test for presence
//! * [`path_delete`] — remove a key/index; returns `true` if something was removed
//! * [`path_move`] — move an array element within or between arrays
//! * [`path_project`] — copy a path into another tree; `*` means every index
//!
//! Numeric segments are interpreted as array indices when the current
//! node is an array; otherwise they're treated as object keys (so
//! `map.0.name` is a valid path into `{"0": {"name": …}}`).
//!
//! `*` is a segment only [`path_project`] understands. The other four treat
//! it as an ordinary key — one that no array index and, since bindings admit
//! only identifier characters in a segment, no template-written path ever
//! spells — so a wildcard reaching them resolves to nothing rather than to
//! something surprising.
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

/// Copy whatever `source` holds at `pattern` into `out`, building the
/// containers on the way. Returns `true` if at least one value was copied.
///
/// This is the one place a `*` segment means anything: it matches **every
/// index** of an array — only an array, because the wildcard exists to spell
/// "each row of a `ForEach`", and a `ForEach` iterates nothing else. An object
/// or scalar where `*` expects an array matches nothing.
///
/// The shape of `out` follows two rules a reader can rely on:
///
/// * An array keeps the source's **length and order**. Projecting
///   `products.*.sku` yields one slot per product, each holding just its
///   `sku`; a row the pattern reaches nothing in stays `null` rather than
///   being dropped, so index 3 of the projection is index 3 of the original.
///   That is what makes a projected row addressable. A concrete index
///   (`products.3.sku`) sizes the array the same way.
/// * A miss leaves **no trace**: when nothing under a key was copied the key
///   is not created, and a container this call built for a miss is taken
///   down again. `out` is untouched whenever `false` is returned.
///
/// The one thing a wildcard always copies is the array's arity: `*` over an
/// array **matches**, even an empty one or one whose rows all miss, and the
/// result is the array with `null` in every missed slot. An empty declared
/// list therefore reads as `[]` and not as a refusal, and the row count is
/// something a rendered list shows anyway — one row per element.
///
/// Several calls may project into the same `out` — that is how a set of
/// declared paths is assembled into one tree. A later call never removes what
/// an earlier one placed, though a wider pattern (`products.*`) overwrites
/// the narrower rows a previous one left.
pub fn path_project(source: &Value, pattern: &str, out: &mut Value) -> bool {
    if pattern.is_empty() {
        *out = source.clone();
        return true;
    }
    let segments: Vec<&str> = pattern.split('.').collect();
    project_into(source, &segments, out)
}

fn project_into(source: &Value, segments: &[&str], out: &mut Value) -> bool {
    let Some((segment, rest)) = segments.split_first() else {
        *out = source.clone();
        return true;
    };

    match source {
        Value::Array(items) => {
            let indices: Vec<usize> = if *segment == "*" {
                (0..items.len()).collect()
            } else {
                match segment.parse::<usize>() {
                    Ok(idx) if idx < items.len() => vec![idx],
                    _ => return false,
                }
            };
            let was_array = out.is_array();
            if !was_array {
                *out = Value::Array(Vec::new());
            }
            let Value::Array(slots) = out else {
                unreachable!("just made it an array");
            };
            if slots.len() < items.len() {
                slots.resize(items.len(), Value::Null);
            }
            // The wildcard has matched the array itself; a concrete index
            // has matched nothing until its row yields something.
            let mut copied = *segment == "*";
            for idx in indices {
                copied |= project_into(&items[idx], rest, &mut slots[idx]);
            }
            if !copied && !was_array {
                *out = Value::Null;
            }
            copied
        }
        Value::Object(map) => {
            let Some(child) = map.get(*segment) else {
                return false;
            };
            let was_object = out.is_object();
            if !was_object {
                *out = Value::Object(serde_json::Map::new());
            }
            let Value::Object(out_map) = out else {
                unreachable!("just made it an object");
            };
            let slot = out_map.entry(segment.to_string()).or_insert(Value::Null);
            let copied = project_into(child, rest, slot);
            if !copied {
                if out_map.get(*segment).is_some_and(Value::is_null) {
                    out_map.remove(*segment);
                }
                if !was_object && out_map.is_empty() {
                    *out = Value::Null;
                }
            }
            copied
        }
        _ => false,
    }
}

/// Borrow the value at a dotted path (no clone). Empty path = root.
fn path_ref<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut current = value;
    for part in path.split('.') {
        match current {
            Value::Object(map) => current = map.get(part)?,
            Value::Array(arr) => current = arr.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        }
    }
    Some(current)
}

/// Mutably borrow the value at a dotted path. Empty path = root. Never
/// auto-vivifies — a missing segment is `None`.
fn path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut current = value;
    for part in path.split('.') {
        match current {
            Value::Object(map) => current = map.get_mut(part)?,
            Value::Array(arr) => current = arr.get_mut(part.parse::<usize>().ok()?)?,
            _ => return None,
        }
    }
    Some(current)
}

/// Move element `from` of the array at `from_path` to become index `to` of
/// the array at `to_path` (which may be the same path). Returns `false` and
/// leaves `target` untouched unless both paths resolve to arrays and `from`
/// is in range. `to` is clamped to `[0, dest.len()]` AFTER the removal, so
/// it is the moved item's FINAL index in the destination
/// (`arr.splice(to, 0, arr.splice(from, 1)[0])` semantics). A same-array
/// move with `from == to` is a no-op returning `true`.
///
/// This is the canonical `__hypen_reorder` semantics
/// (`hypen-web/docs/dnd.md`); every host SDK applies
/// reorders through it (or a byte-equal mirror pinned by the
/// `engine-compatibility-tests/fixtures/dnd/path-move.json` cases).
pub fn path_move(
    target: &mut Value,
    from_path: &str,
    from: usize,
    to_path: &str,
    to: usize,
) -> bool {
    if from_path == to_path {
        let Some(Value::Array(arr)) = path_mut(target, from_path) else {
            return false;
        };
        if from >= arr.len() {
            return false;
        }
        if from == to {
            return true;
        }
        let item = arr.remove(from);
        let to = to.min(arr.len());
        arr.insert(to, item);
        return true;
    }

    // Validate both ends before mutating anything.
    if !matches!(path_ref(target, to_path), Some(Value::Array(_))) {
        return false;
    }
    // A destination INSIDE the source array (tree DnD: `entries` →
    // `entries.3.children`) sees the removal shift its siblings: the moved
    // element itself is gone (refuse — nothing sensible to do), and every
    // element past `from` is one index lower afterwards (re-address).
    let adjusted_to_path = match destination_index_in_source(from_path, to_path) {
        Some((j, _)) if j == from => return false,
        Some((j, tail)) if j > from => Some(match tail {
            Some(tail) => join_path(from_path, &format!("{}.{}", j - 1, tail)),
            None => join_path(from_path, &(j - 1).to_string()),
        }),
        _ => None,
    };
    let to_path = adjusted_to_path.as_deref().unwrap_or(to_path);

    let item = {
        let Some(Value::Array(src)) = path_mut(target, from_path) else {
            return false;
        };
        if from >= src.len() {
            return false;
        }
        src.remove(from)
    };
    match path_mut(target, to_path) {
        Some(Value::Array(dst)) => {
            let to = to.min(dst.len());
            dst.insert(to, item);
            true
        }
        // Unreachable after the validation above; kept as a safety net so a
        // failed move can never lose the element.
        _ => {
            if let Some(Value::Array(src)) = path_mut(target, from_path) {
                src.insert(from.min(src.len()), item);
            }
            false
        }
    }
}

/// When `to_path` lies under an element of the array at `from_path`, return
/// that element's index and the remaining path below it (`None` tail =
/// the element itself). `None` when the destination is elsewhere.
fn destination_index_in_source(from_path: &str, to_path: &str) -> Option<(usize, Option<String>)> {
    let rest = if from_path.is_empty() {
        to_path
    } else {
        to_path.strip_prefix(from_path)?.strip_prefix('.')?
    };
    let (first, tail) = match rest.split_once('.') {
        Some((a, b)) => (a, Some(b.to_string())),
        None => (rest, None),
    };
    Some((first.parse::<usize>().ok()?, tail))
}

fn join_path(base: &str, rest: &str) -> String {
    if base.is_empty() {
        rest.to_string()
    } else {
        format!("{base}.{rest}")
    }
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

    // ── path_project ─────────────────────────────────────────────

    fn shop() -> Value {
        json!({
            "products": [
                {"sku": "A", "title": "Shirt", "cost": 3,
                 "variants": [{"size": "M", "stock": 1}, {"size": "L", "stock": 0}]},
                {"sku": "B", "title": "Hat", "cost": 4, "variants": []},
                {"title": "No sku"}
            ],
            "user": {"name": "Ada", "email": "a@x"},
            "_token": "secret"
        })
    }

    #[test]
    fn project_wildcard_keeps_one_slot_per_row_with_only_the_named_field() {
        let mut out = json!({});
        assert!(path_project(&shop(), "products.*.sku", &mut out));
        // Same length and order as the source; a row without the field keeps
        // its position as `null` rather than being dropped, so index 1 is
        // still B and index 2 is still the third product.
        assert_eq!(out, json!({"products": [{"sku": "A"}, {"sku": "B"}, null]}));
    }

    #[test]
    fn project_merges_several_patterns_into_one_tree() {
        let mut out = json!({});
        path_project(&shop(), "products.*.sku", &mut out);
        path_project(&shop(), "products.*.title", &mut out);
        path_project(&shop(), "user.name", &mut out);
        assert_eq!(
            out,
            json!({
                "products": [
                    {"sku": "A", "title": "Shirt"},
                    {"sku": "B", "title": "Hat"},
                    {"title": "No sku"}
                ],
                "user": {"name": "Ada"}
            })
        );
    }

    #[test]
    fn project_nested_wildcards_descend_row_by_row() {
        let mut out = json!({});
        assert!(path_project(&shop(), "products.*.variants.*.size", &mut out));
        assert_eq!(
            out,
            // Row 1 has an empty `variants` (the inner wildcard matched it,
            // so it is `[]`); row 2 has none at all (a miss, so `null`).
            json!({"products": [
                {"variants": [{"size": "M"}, {"size": "L"}]},
                {"variants": []},
                null
            ]})
        );
    }

    #[test]
    fn project_whole_row_wildcard_copies_rows_verbatim() {
        let mut out = json!({});
        assert!(path_project(&shop(), "products.*", &mut out));
        assert_eq!(out["products"], shop()["products"]);
    }

    #[test]
    fn project_concrete_index_keeps_the_position() {
        let mut out = json!({});
        assert!(path_project(&shop(), "products.1.sku", &mut out));
        assert_eq!(out, json!({"products": [null, {"sku": "B"}, null]}));
        assert!(!path_project(&shop(), "products.9.sku", &mut out));
    }

    #[test]
    fn project_wildcard_matches_only_arrays() {
        let mut out = json!({});
        // `user` is an object: `*` does not fan out over its keys.
        assert!(!path_project(&shop(), "user.*", &mut out));
        assert!(!path_project(&shop(), "_token.*", &mut out));
        assert_eq!(out, json!({}), "a miss leaves no empty container behind");
    }

    #[test]
    fn project_wildcard_keeps_the_arity_even_when_every_row_misses() {
        let mut out = json!({});
        // The wildcard reached the array: three rows, none with the field.
        assert!(path_project(&shop(), "products.*.nope", &mut out));
        assert_eq!(out, json!({"products": [null, null, null]}));

        // And an empty list is an empty list, not a miss.
        let mut out = json!({});
        assert!(path_project(&json!({"items": []}), "items.*.sku", &mut out));
        assert_eq!(out, json!({"items": []}));
    }

    #[test]
    fn project_missing_path_leaves_no_trace() {
        let mut out = json!({});
        assert!(!path_project(&shop(), "missing.x", &mut out));
        assert!(!path_project(&shop(), "user.nope.deeper", &mut out));
        // A concrete row that lacks the field is a miss, and takes the
        // containers built on the way to it down again.
        assert!(!path_project(&shop(), "products.2.sku", &mut out));
        assert_eq!(out, json!({}));

        // And a miss never disturbs what an earlier pattern placed.
        let mut out = json!({});
        path_project(&shop(), "products.*.sku", &mut out);
        let before = out.clone();
        assert!(!path_project(&shop(), "products.2.sku", &mut out));
        assert!(!path_project(&shop(), "user.nope", &mut out));
        assert_eq!(out, before);
    }

    #[test]
    fn project_empty_pattern_is_the_root() {
        let mut out = json!({});
        assert!(path_project(&shop(), "", &mut out));
        assert_eq!(out, shop());
    }
    #[test]
    fn move_same_array_forward() {
        let mut v = json!({"tasks": ["a", "b", "c", "d"]});
        assert!(path_move(&mut v, "tasks", 0, "tasks", 2));
        assert_eq!(v, json!({"tasks": ["b", "c", "a", "d"]}));
    }

    #[test]
    fn move_same_array_backward() {
        let mut v = json!({"tasks": ["a", "b", "c", "d"]});
        assert!(path_move(&mut v, "tasks", 3, "tasks", 1));
        assert_eq!(v, json!({"tasks": ["a", "d", "b", "c"]}));
    }

    #[test]
    fn move_same_index_is_noop_true() {
        let mut v = json!({"tasks": ["a", "b", "c"]});
        assert!(path_move(&mut v, "tasks", 1, "tasks", 1));
        assert_eq!(v, json!({"tasks": ["a", "b", "c"]}));
    }

    #[test]
    fn move_to_beyond_length_clamps_to_end() {
        let mut v = json!({"tasks": ["a", "b", "c"]});
        assert!(path_move(&mut v, "tasks", 0, "tasks", 99));
        assert_eq!(v, json!({"tasks": ["b", "c", "a"]}));

        let mut v = json!({"todo": ["a"], "done": ["x"]});
        assert!(path_move(&mut v, "todo", 0, "done", 42));
        assert_eq!(v, json!({"todo": [], "done": ["x", "a"]}));
    }

    #[test]
    fn move_cross_array() {
        let mut v = json!({"todo": ["a", "b"], "doing": ["x"]});
        assert!(path_move(&mut v, "todo", 1, "doing", 0));
        assert_eq!(v, json!({"todo": ["a"], "doing": ["b", "x"]}));
    }

    #[test]
    fn move_cross_array_nested_paths() {
        let mut v = json!({"cols": [{"items": ["a"]}, {"items": ["b", "c"]}]});
        assert!(path_move(&mut v, "cols.1.items", 1, "cols.0.items", 1));
        assert_eq!(
            v,
            json!({"cols": [{"items": ["a", "c"]}, {"items": ["b"]}]})
        );
    }

    #[test]
    fn move_from_out_of_range_is_false_and_untouched() {
        let mut v = json!({"tasks": ["a", "b"], "done": []});
        assert!(!path_move(&mut v, "tasks", 2, "tasks", 0));
        assert!(!path_move(&mut v, "tasks", 5, "done", 0));
        assert_eq!(v, json!({"tasks": ["a", "b"], "done": []}));
    }

    #[test]
    fn move_non_array_path_is_false_and_untouched() {
        let mut v = json!({"tasks": ["a", "b"], "meta": {"n": 1}, "s": "str"});
        assert!(!path_move(&mut v, "meta", 0, "tasks", 0));
        assert!(!path_move(&mut v, "tasks", 0, "meta", 0));
        assert!(!path_move(&mut v, "tasks", 0, "missing", 0));
        assert!(!path_move(&mut v, "s", 0, "s", 1));
        assert_eq!(
            v,
            json!({"tasks": ["a", "b"], "meta": {"n": 1}, "s": "str"})
        );
    }

    #[test]
    fn move_destination_inside_moved_item_is_false_and_untouched() {
        let mut v = json!({"items": [{"children": []}, {"children": ["z"]}]});
        assert!(!path_move(&mut v, "items", 0, "items.0.children", 0));
        assert_eq!(v, json!({"items": [{"children": []}, {"children": ["z"]}]}));
    }

    #[test]
    fn move_into_later_sibling_subtree_reindexes_destination() {
        // Tree DnD: drop entry 0 into entry 2's children. After the
        // removal that folder sits at index 1 — the move must still land
        // in the SAME folder, not the one that shifted into index 2.
        let mut v = json!({"entries": [
            {"id": "f", "children": []},
            {"id": "a", "children": ["a1"]},
            {"id": "b", "children": ["b1"]}
        ]});
        assert!(path_move(&mut v, "entries", 0, "entries.2.children", 1));
        assert_eq!(
            v,
            json!({"entries": [
                {"id": "a", "children": ["a1"]},
                {"id": "b", "children": ["b1", {"id": "f", "children": []}]}
            ]})
        );

        // Earlier sibling: no shift.
        let mut v = json!({"entries": [{"children": []}, "x"]});
        assert!(path_move(&mut v, "entries", 1, "entries.0.children", 0));
        assert_eq!(v, json!({"entries": [{"children": ["x"]}]}));

        // Root-array source with a nested destination.
        let mut v = json!([{"children": []}, "x"]);
        assert!(path_move(&mut v, "", 1, "0.children", 0));
        assert_eq!(v, json!([{"children": ["x"]}]));
    }

    #[test]
    fn move_out_of_nested_subtree_into_parent_array() {
        let mut v = json!({"entries": [{"children": ["a1"]}, "x"]});
        assert!(path_move(&mut v, "entries.0.children", 0, "entries", 0));
        assert_eq!(v, json!({"entries": ["a1", {"children": []}, "x"]}));
    }

    #[test]
    fn move_root_array_with_empty_path() {
        let mut v = json!(["a", "b", "c"]);
        assert!(path_move(&mut v, "", 2, "", 0));
        assert_eq!(v, json!(["c", "a", "b"]));
    }

    #[test]
    fn move_matches_dnd_conformance_fixture() {
        // Every case in the cross-SDK fixture must reproduce byte-equal
        // through the engine's canonical implementation.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine-compatibility-tests/fixtures/dnd/path-move.json"
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture readable"))
                .expect("fixture is JSON");
        assert_eq!(fixture["function"], json!("path_move"));
        let cases = fixture["cases"].as_array().expect("cases array");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().expect("case name");
            let mut state = case["state"].clone();
            let op = &case["op"];
            let moved = path_move(
                &mut state,
                op["fromPath"].as_str().expect("fromPath"),
                op["from"].as_u64().expect("from") as usize,
                op["toPath"].as_str().expect("toPath"),
                op["to"].as_u64().expect("to") as usize,
            );
            assert_eq!(moved, case["moved"], "case '{name}': moved flag");
            assert_eq!(state, case["expected"], "case '{name}': resulting state");
        }
    }
}
