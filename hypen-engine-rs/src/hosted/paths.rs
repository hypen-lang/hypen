//! Which state paths a write changes, and whether a changed path concerns a
//! watched one.
//!
//! Paths are the engine's dotted state paths (`user.name`, `items.0.title`).
//! They feed two consumers: binding invalidation (the reactive graph) and
//! cross-module subscription matching. The three collectors report the same
//! path shapes for the three kinds of write — a reducer's wholesale
//! replacement, a host deep-merge, a host sparse write — so a subscription
//! fires identically whoever wrote the state.

/// Whether a changed state path `changed` should trigger a subscription to
/// `watched`: true when they are the same, when one is a descendant of the
/// other (a parent change implies the child changed, and vice-versa), or when
/// either is empty (a whole-state watch / whole-state replacement).
pub(crate) fn paths_overlap(changed: &str, watched: &str) -> bool {
    fn is_ancestor(ancestor: &str, path: &str) -> bool {
        path.len() > ancestor.len()
            && path.as_bytes().get(ancestor.len()) == Some(&b'.')
            && path.starts_with(ancestor)
    }
    changed.is_empty()
        || watched.is_empty()
        || changed == watched
        || is_ancestor(watched, changed)
        || is_ancestor(changed, watched)
}

/// Collect the dotted paths at which `new` differs from `old`, for binding
/// invalidation and subscription matching (the state itself is replaced
/// wholesale, so nothing here has to be able to *reconstruct* `new`).
///
/// - Changed, added and removed object keys report `prefix.key`.
/// - Arrays compare index by index; a shrunk array reports the array itself.
/// - A key the dotted-path system cannot address (empty, or containing `.`)
///   reports its parent instead — over-invalidating the parent rather than
///   naming a path that would alias a different, nested value. At the root
///   that is the empty path: "the whole state".
///
/// `prefix` is scratch space and is restored before returning.
pub(crate) fn collect_changed_paths(
    old: &serde_json::Value,
    new: &serde_json::Value,
    prefix: &mut String,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    use std::fmt::Write;

    fn with_segment<R>(prefix: &mut String, segment: &str, f: impl FnOnce(&mut String) -> R) -> R {
        let len = prefix.len();
        if len > 0 {
            prefix.push('.');
        }
        prefix.push_str(segment);
        let result = f(prefix);
        prefix.truncate(len);
        result
    }
    fn addressable(key: &str) -> bool {
        !key.is_empty() && !key.contains('.')
    }

    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            let mut parent_changed = false;
            for (key, old_value) in old_map {
                let new_value = new_map.get(key);
                if !addressable(key) {
                    parent_changed |= new_value != Some(old_value);
                    continue;
                }
                match new_value {
                    Some(new_value) => with_segment(prefix, key, |path| {
                        collect_changed_paths(old_value, new_value, path, out)
                    }),
                    None => with_segment(prefix, key, |path| out.push(path.clone())),
                }
            }
            for key in new_map.keys() {
                if old_map.contains_key(key) {
                    continue;
                }
                if addressable(key) {
                    with_segment(prefix, key, |path| out.push(path.clone()));
                } else {
                    parent_changed = true;
                }
            }
            if parent_changed {
                out.push(prefix.clone());
            }
        }
        (Value::Array(old_items), Value::Array(new_items)) => {
            if new_items.len() < old_items.len() {
                out.push(prefix.clone());
                return;
            }
            let mut segment = String::new();
            for (index, new_item) in new_items.iter().enumerate() {
                segment.clear();
                // Writing to a `String` cannot fail.
                let _ = write!(segment, "{index}");
                let segment = segment.as_str();
                match old_items.get(index) {
                    Some(old_item) => with_segment(prefix, segment, |path| {
                        collect_changed_paths(old_item, new_item, path, out)
                    }),
                    None => with_segment(prefix, segment, |path| out.push(path.clone())),
                }
            }
        }
        (old, new) => {
            if old != new {
                out.push(prefix.clone());
            }
        }
    }
}

/// The changed paths (as [`collect_changed_paths`] reports them) that
/// deep-merging `patch` into `target` — `ModuleInstance::update_state`'s
/// merge — would produce, without performing it: objects merge key by key,
/// anything else replaces the target value.
pub(crate) fn collect_merge_changes(
    target: &serde_json::Value,
    patch: &serde_json::Value,
    prefix: &mut String,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    let (Value::Object(target_map), Value::Object(patch_map)) = (target, patch) else {
        collect_changed_paths(target, patch, prefix, out);
        return;
    };
    let mut parent_changed = false;
    for (key, value) in patch_map {
        let addressable = !key.is_empty() && !key.contains('.');
        match (target_map.get(key), addressable) {
            (Some(old), true) => {
                let len = prefix.len();
                if len > 0 {
                    prefix.push('.');
                }
                prefix.push_str(key);
                collect_merge_changes(old, value, prefix, out);
                prefix.truncate(len);
            }
            (None, true) => {
                let mut path = prefix.clone();
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                out.push(path);
            }
            // Not addressable by a dotted path: report the parent, as
            // `collect_changed_paths` does.
            (Some(old), false) => {
                let mut scratch = Vec::new();
                collect_merge_changes(old, value, &mut String::new(), &mut scratch);
                parent_changed |= !scratch.is_empty();
            }
            (None, false) => parent_changed = true,
        }
    }
    if parent_changed {
        out.push(prefix.clone());
    }
}

/// The changed paths writing `value` at the dotted `path` of `state` —
/// `ModuleInstance::update_state_sparse`'s auto-vivifying write — would
/// produce, without performing it. A missing or non-container segment
/// reports the path down to that segment (that is what gets created or
/// replaced); a present value is compared like [`collect_changed_paths`].
pub(crate) fn collect_sparse_changes(
    state: &serde_json::Value,
    path: &str,
    value: &serde_json::Value,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    let mut current = state;
    // Byte offset just past the segments walked so far, counting the `.`
    // after each: `end - 1` is always a segment boundary inside `path` (so a
    // valid slice point), whatever the host put in the path.
    let mut end: usize = 0;
    for segment in path.split('.') {
        let index = match current {
            Value::Array(_) => segment.parse::<usize>().ok(),
            _ => None,
        };
        let next = match (current, index) {
            (Value::Object(map), _) => map.get(segment),
            (Value::Array(items), Some(index)) => items.get(index),
            // A scalar (or an array addressed by a non-index key) in the way
            // is replaced by an object holding the rest.
            _ => {
                out.push(path[..end.saturating_sub(1)].to_string());
                return;
            }
        };
        end += segment.len() + 1;
        match next {
            Some(next) => current = next,
            None => {
                out.push(path[..end - 1].to_string());
                return;
            }
        }
    }
    collect_changed_paths(current, value, &mut path.to_string(), out);
}

#[cfg(test)]
mod tests {
    use super::{
        collect_changed_paths, collect_merge_changes, collect_sparse_changes, paths_overlap,
    };
    use serde_json::{json, Value};

    fn changed(old: Value, new: Value) -> Vec<String> {
        let mut out = Vec::new();
        let mut prefix = String::new();
        collect_changed_paths(&old, &new, &mut prefix, &mut out);
        assert!(prefix.is_empty(), "scratch prefix must be restored");
        out
    }

    #[test]
    fn paths_overlap_matches_equal_ancestor_and_descendant_paths_only() {
        assert!(paths_overlap("a.b", "a.b"));
        assert!(paths_overlap("a", "a.b"));
        assert!(paths_overlap("a.b.c", "a.b"));
        assert!(paths_overlap("", "a.b"));
        assert!(paths_overlap("a.b", ""));
        // A shared string prefix is not a shared path prefix.
        assert!(!paths_overlap("ab", "a"));
        assert!(!paths_overlap("a", "ab"));
        assert!(!paths_overlap("a.bc", "a.b"));
        assert!(!paths_overlap("a.b", "a.c"));
    }

    #[test]
    fn changed_paths_are_minimal_for_addressable_keys() {
        assert!(changed(
            json!({ "a": { "b": [1, 2] } }),
            json!({ "a": { "b": [1, 2] } })
        )
        .is_empty());
        assert_eq!(
            changed(
                json!({ "a": { "b": 1, "c": 2 }, "gone": 1, "list": [1, 2] }),
                json!({ "a": { "b": 1, "c": 3 }, "new": 1, "list": [1, 5, 9] }),
            ),
            ["a.c", "gone", "list.1", "list.2", "new"]
        );
        // Shrinking reports the array itself; a type change its own path.
        assert_eq!(
            changed(
                json!({ "list": [1, 2], "t": { "x": 1 } }),
                json!({ "list": [1], "t": [1] })
            ),
            ["list", "t"]
        );
    }

    #[test]
    fn unaddressable_keys_report_their_parent() {
        assert_eq!(
            changed(
                json!({ "cfg": { "x": 1 } }),
                json!({ "cfg": { "x": 1, "a.b": 2 } })
            ),
            ["cfg"]
        );
        assert_eq!(
            changed(
                json!({ "cfg": { "": 1, "a.b": 2 } }),
                json!({ "cfg": { "": 1 } })
            ),
            ["cfg"]
        );
        // At the root the parent is the whole state.
        assert_eq!(changed(json!({ "a.b": 1 }), json!({ "a.b": 2 })), [""]);
        assert!(changed(json!({ "a.b": 1 }), json!({ "a.b": 1 })).is_empty());
    }

    #[test]
    fn merge_changes_preview_the_deep_merge_without_deletions() {
        fn merged(target: serde_json::Value, patch: serde_json::Value) -> Vec<String> {
            let mut out = Vec::new();
            collect_merge_changes(&target, &patch, &mut String::new(), &mut out);
            out
        }
        let state = json!({ "user": { "name": "a", "age": 1 }, "items": [1, 2], "n": 0 });
        // Keys absent from the patch are kept, not reported as removed.
        assert_eq!(
            merged(state.clone(), json!({ "user": { "name": "b" } })),
            ["user.name"]
        );
        assert!(merged(state.clone(), json!({ "user": { "name": "a" }, "n": 0 })).is_empty());
        // New keys, replaced arrays and type changes report like the fold.
        assert_eq!(
            merged(state.clone(), json!({ "user": { "x": 1 } })),
            ["user.x"]
        );
        assert_eq!(
            merged(state.clone(), json!({ "items": [1, 3] })),
            ["items.1"]
        );
        assert_eq!(merged(state.clone(), json!({ "items": [1] })), ["items"]);
        assert_eq!(merged(state.clone(), json!({ "n": { "deep": 1 } })), ["n"]);
        // Non-addressable keys report their parent.
        assert_eq!(merged(state, json!({ "user": { "a.b": 1 } })), ["user"]);
    }

    #[test]
    fn sparse_changes_preview_the_auto_vivifying_write() {
        fn sparse(state: serde_json::Value, path: &str, value: serde_json::Value) -> Vec<String> {
            let mut out = Vec::new();
            collect_sparse_changes(&state, path, &value, &mut out);
            out
        }
        let state = json!({ "user": { "name": "a" }, "items": [{ "t": 1 }], "n": 0 });
        assert_eq!(
            sparse(state.clone(), "user.name", json!("b")),
            ["user.name"]
        );
        assert!(sparse(state.clone(), "user.name", json!("a")).is_empty());
        assert_eq!(sparse(state.clone(), "items.0.t", json!(2)), ["items.0.t"]);
        assert_eq!(
            sparse(state.clone(), "user", json!({ "name": "b" })),
            ["user.name"]
        );
        // Created segments report the first one created.
        assert_eq!(sparse(state.clone(), "a.b.c", json!(1)), ["a"]);
        assert_eq!(sparse(state.clone(), "items.3", json!(1)), ["items.3"]);
        // A scalar or non-index array segment in the way is replaced.
        assert_eq!(sparse(state.clone(), "n.x", json!(1)), ["n"]);
        assert_eq!(sparse(state, "items.key", json!(1)), ["items"]);
    }
}
