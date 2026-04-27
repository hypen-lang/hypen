//! JSON tree diff.
//!
//! Given `old` and `new` JSON values, return every leaf that changed as
//! a `(path, new_value)` entry. Paths use dotted notation (`"user.name"`,
//! `"items.0.title"`) so they feed directly into the engine's
//! path-based reactive graph.

use serde_json::Value;

/// A single change detected by [`diff_paths`].
#[derive(Debug, Clone, PartialEq)]
pub struct DiffEntry {
    /// Dotted path to the changed leaf, e.g. `"user.name"` or `"items.42.title"`.
    pub path: String,
    /// The new value at that path. `Value::Null` for deleted keys.
    pub new_value: Value,
}

/// Recursively compare `old` and `new` and return every leaf that differs.
///
/// * Objects recurse by key; keys present only in `new` appear as
///   `(path, new_value)`; keys present only in `old` appear as
///   `(path, Null)`.
/// * Arrays recurse index-by-index up to the longer length; indices
///   beyond the shorter length appear as additions or removals.
/// * Primitives compare by value.
///
/// Paths never include a leading dot; the root is the empty string and
/// is never emitted on its own.
pub fn diff_paths(old: &Value, new: &Value) -> Vec<DiffEntry> {
    let mut out = Vec::new();
    diff_into("", old, new, &mut out);
    out
}

fn diff_into(prefix: &str, old: &Value, new: &Value, out: &mut Vec<DiffEntry>) {
    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            for (key, old_val) in old_map {
                let path = join(prefix, key);
                match new_map.get(key) {
                    Some(new_val) => diff_into(&path, old_val, new_val, out),
                    None => out.push(DiffEntry {
                        path,
                        new_value: Value::Null,
                    }),
                }
            }
            for (key, new_val) in new_map {
                if !old_map.contains_key(key) {
                    out.push(DiffEntry {
                        path: join(prefix, key),
                        new_value: new_val.clone(),
                    });
                }
            }
        }
        (Value::Array(old_arr), Value::Array(new_arr)) => {
            // Shrinking arrays emit a whole-array replacement at the
            // prefix path rather than per-index nulls for dropped
            // indices. `set_value_at_path` only mutates individual
            // indices — it never truncates — so per-index nulls would
            // leave phantom null slots at the tail of the array.
            // Downstream ForEach reconciliation would iterate over those
            // nulls, fail item-binding substitution (`item.id` on null
            // has no field), and render rows showing the raw unresolved
            // binding string ("null" / "@{item.…}"). Replacing the
            // whole array sidesteps that and is cheaper anyway.
            //
            // Growing and same-length cases stay granular so a single
            // leaf edit still produces the minimal `foods.K.field = …`
            // delta, and `push("d")` still emits only `items.<newIdx>`
            // (which matches the cross-SDK canonical contract exercised
            // by `state.test.ts::identifies array element and length changes`).
            if new_arr.len() < old_arr.len() && !prefix.is_empty() {
                out.push(DiffEntry {
                    path: prefix.to_string(),
                    new_value: Value::Array(new_arr.clone()),
                });
                return;
            }
            let max_len = old_arr.len().max(new_arr.len());
            for i in 0..max_len {
                let path = join(prefix, &i.to_string());
                match (old_arr.get(i), new_arr.get(i)) {
                    (Some(o), Some(n)) => diff_into(&path, o, n, out),
                    (None, Some(n)) => out.push(DiffEntry {
                        path,
                        new_value: n.clone(),
                    }),
                    (Some(_), None) => out.push(DiffEntry {
                        path,
                        new_value: Value::Null,
                    }),
                    (None, None) => unreachable!(),
                }
            }
        }
        (a, b) => {
            if a != b && !prefix.is_empty() {
                out.push(DiffEntry {
                    path: prefix.to_string(),
                    new_value: b.clone(),
                });
            }
        }
    }
}

fn join(prefix: &str, segment: &str) -> String {
    if prefix.is_empty() {
        segment.to_string()
    } else {
        let mut s = String::with_capacity(prefix.len() + 1 + segment.len());
        s.push_str(prefix);
        s.push('.');
        s.push_str(segment);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_change_returns_empty() {
        let a = json!({"count": 0, "name": "Alice"});
        assert!(diff_paths(&a, &a.clone()).is_empty());
    }

    #[test]
    fn scalar_change_at_top_level() {
        let entries = diff_paths(&json!({"count": 0}), &json!({"count": 1}));
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "count".into(),
                new_value: json!(1),
            }]
        );
    }

    #[test]
    fn nested_object_change() {
        let entries = diff_paths(
            &json!({"user": {"name": "Alice", "age": 30}}),
            &json!({"user": {"name": "Alice", "age": 31}}),
        );
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "user.age".into(),
                new_value: json!(31),
            }]
        );
    }

    #[test]
    fn added_and_removed_keys() {
        let entries = diff_paths(&json!({"a": 1, "b": 2}), &json!({"a": 1, "c": 3}));
        // `b` was removed; `c` was added.
        let mut paths: Vec<_> = entries.iter().map(|e| e.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["b", "c"]);

        let removed = entries.iter().find(|e| e.path == "b").unwrap();
        assert_eq!(removed.new_value, Value::Null);

        let added = entries.iter().find(|e| e.path == "c").unwrap();
        assert_eq!(added.new_value, json!(3));
    }

    /// Paths at array indices >= 10 must serialise as their full
    /// decimal representation ("10", "11", ...), not as a single
    /// character.
    #[test]
    fn array_index_past_nine_uses_full_decimal() {
        let mut old_items: Vec<Value> = (0..12).map(|i| json!({"title": format!("t{i}")})).collect();
        let new_items = old_items.clone();
        // Only mutate index 10's title.
        old_items[10] = json!({"title": "OLD"});

        let entries = diff_paths(&json!({"items": old_items}), &json!({"items": new_items}));
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "items.10.title".into(),
                new_value: json!("t10"),
            }]
        );
    }

    #[test]
    fn array_length_change() {
        // Growing array: new indices show up as additions.
        let entries = diff_paths(&json!([1, 2]), &json!([1, 2, 3, 4]));
        let mut paths: Vec<_> = entries.iter().map(|e| e.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["2", "3"]);

        // Shrinking array: dropped indices show up as deletions (Null).
        let entries = diff_paths(&json!([1, 2, 3]), &json!([1]));
        let mut entries = entries;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            entries,
            vec![
                DiffEntry {
                    path: "1".into(),
                    new_value: Value::Null,
                },
                DiffEntry {
                    path: "2".into(),
                    new_value: Value::Null,
                },
            ]
        );
    }

    #[test]
    fn nested_array_shrink_emits_whole_array() {
        // A nested array that shrinks must emit a single whole-array
        // entry at the parent path — not per-index nulls. Per-index
        // nulls leak through `set_value_at_path`, which doesn't truncate
        // arrays, leaving phantom null slots that break ForEach
        // item-binding substitution downstream.
        let old = json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"},
            {"id": "3", "name": "C"}
        ]});
        let new = json!({"foods": [
            {"id": "1", "name": "A"}
        ]});

        let entries = diff_paths(&old, &new);
        assert_eq!(
            entries.len(),
            1,
            "Shrinking nested array should emit exactly one whole-array entry, got {entries:?}"
        );
        assert_eq!(entries[0].path, "foods");
        assert_eq!(
            entries[0].new_value,
            json!([{"id": "1", "name": "A"}]),
            "Entry value must be the full new array"
        );

        // Same-length nested updates stay granular.
        let old = json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"}
        ]});
        let new = json!({"foods": [
            {"id": "1", "name": "A2"},
            {"id": "2", "name": "B"}
        ]});
        let entries = diff_paths(&old, &new);
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "foods.0.name".into(),
                new_value: json!("A2"),
            }],
            "Same-length update should produce a single granular leaf change"
        );

        // Growing nested arrays stay on the per-index path — matches the
        // cross-SDK canonical contract exercised by
        // `hypen-web/tests/state.test.ts::identifies array element and
        // length changes`, which asserts `state.items.push("d")` emits
        // a single `items.<newIdx>` path.
        let old = json!({"items": ["a", "b"]});
        let new = json!({"items": ["a", "b", "c"]});
        let entries = diff_paths(&old, &new);
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "items.2".into(),
                new_value: json!("c"),
            }],
            "Growing array should emit the new index only, not the whole array"
        );
    }

    #[test]
    fn type_change_emits_new_value() {
        let entries = diff_paths(&json!({"x": 1}), &json!({"x": "one"}));
        assert_eq!(
            entries,
            vec![DiffEntry {
                path: "x".into(),
                new_value: json!("one"),
            }]
        );
    }

    #[test]
    fn root_scalar_identity_emits_nothing() {
        // With an empty prefix we can't name the change; callers that care
        // about root-level scalars should wrap their state in an object.
        assert!(diff_paths(&json!(1), &json!(2)).is_empty());
    }
}
