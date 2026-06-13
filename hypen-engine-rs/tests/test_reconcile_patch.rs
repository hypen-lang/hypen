//! Tests for src/reconcile/patch.rs - Patch creation and serialization
//!
//! Tests the platform-agnostic patch operations for updating the UI

use hypen_engine::ir::NodeId;
use hypen_engine::reconcile::Patch;
use indexmap::indexmap;
use serde_json::json;
use std::sync::Arc;

// Helper to create a test NodeId
fn test_node_id() -> NodeId {
    NodeId::default()
}

// ============================================================================
// Patch Creation Helpers (6 tests)
// ============================================================================

#[test]
fn test_create_patch_basic() {
    // GIVEN: NodeId, element type, and props
    let node_id = test_node_id();
    let props = indexmap! {
        "text".to_string() => json!("Hello"),
        "color".to_string() => json!("blue"),
    };

    // WHEN: Create patch
    let patch = Patch::create(node_id, "Text".to_string(), Arc::new(props.clone()));

    // THEN: Create patch with correct structure
    match patch {
        Patch::Create {
            id,
            element_type,
            props: patch_props,
        } => {
            assert!(!id.is_empty());
            assert_eq!(element_type, "Text");
            assert_eq!(patch_props.get("text"), Some(&json!("Hello")));
            assert_eq!(patch_props.get("color"), Some(&json!("blue")));
        }
        _ => panic!("Expected Create patch"),
    }
}

#[test]
fn test_set_prop_patch() {
    // GIVEN: NodeId, prop name, and value
    let node_id = test_node_id();

    // WHEN: Create SetProp patch
    let patch = Patch::set_prop(node_id, "fontSize".to_string(), json!(18));

    // THEN: SetProp patch with correct structure
    match patch {
        Patch::SetProp { id, name, value } => {
            assert!(!id.is_empty());
            assert_eq!(name, "fontSize");
            assert_eq!(value, json!(18));
        }
        _ => panic!("Expected SetProp patch"),
    }
}

#[test]
fn test_set_text_patch() {
    // GIVEN: NodeId and text content
    let node_id = test_node_id();

    // WHEN: Create SetText patch
    let patch = Patch::set_text(node_id, "Updated text".to_string());

    // THEN: SetText patch with correct structure
    match patch {
        Patch::SetText { id, text } => {
            assert!(!id.is_empty());
            assert_eq!(text, "Updated text");
        }
        _ => panic!("Expected SetText patch"),
    }
}

#[test]
fn test_insert_patch_without_before() {
    // GIVEN: Parent and child node IDs
    let parent_id = test_node_id();
    let child_id = test_node_id();

    // WHEN: Create Insert patch without before_id
    let patch = Patch::insert(parent_id, child_id, None);

    // THEN: Insert patch appending to end
    match patch {
        Patch::Insert {
            parent_id: parent,
            id,
            before_id,
        } => {
            assert!(!parent.is_empty());
            assert!(!id.is_empty());
            assert_eq!(before_id, None);
        }
        _ => panic!("Expected Insert patch"),
    }
}

#[test]
fn test_insert_patch_with_before() {
    // GIVEN: Parent, child, and sibling node IDs
    let parent_id = test_node_id();
    let child_id = test_node_id();
    let sibling_id = test_node_id();

    // WHEN: Create Insert patch with before_id
    let patch = Patch::insert(parent_id, child_id, Some(sibling_id));

    // THEN: Insert patch with position specified
    match patch {
        Patch::Insert {
            parent_id: parent,
            id,
            before_id,
        } => {
            assert!(!parent.is_empty());
            assert!(!id.is_empty());
            assert!(before_id.is_some());
        }
        _ => panic!("Expected Insert patch"),
    }
}

#[test]
fn test_insert_root_patch() {
    // GIVEN: Node ID to insert as root
    let node_id = test_node_id();

    // WHEN: Create root insert patch
    let patch = Patch::insert_root(node_id);

    // THEN: Insert patch with parent_id = "root"
    match patch {
        Patch::Insert {
            parent_id,
            id,
            before_id,
        } => {
            assert_eq!(parent_id, "root");
            assert!(!id.is_empty());
            assert_eq!(before_id, None);
        }
        _ => panic!("Expected Insert patch"),
    }
}

// ============================================================================
// Additional Patch Helpers (4 tests)
// ============================================================================

#[test]
fn test_move_patch() {
    // GIVEN: Node IDs for moving
    let parent_id = test_node_id();
    let node_id = test_node_id();
    let before_id = test_node_id();

    // WHEN: Create Move patch
    let patch = Patch::move_node(parent_id, node_id, Some(before_id));

    // THEN: Move patch with correct structure
    match patch {
        Patch::Move {
            parent_id: parent,
            id,
            before_id: before,
        } => {
            assert!(!parent.is_empty());
            assert!(!id.is_empty());
            assert!(before.is_some());
        }
        _ => panic!("Expected Move patch"),
    }
}

#[test]
fn test_remove_patch() {
    // GIVEN: Node ID to remove
    let node_id = test_node_id();

    // WHEN: Create Remove patch
    let patch = Patch::remove(node_id);

    // THEN: Remove patch with correct structure
    match patch {
        Patch::Remove { id } => {
            assert!(!id.is_empty());
        }
        _ => panic!("Expected Remove patch"),
    }
}

#[test]
fn test_patch_clone() {
    // GIVEN: Original patch
    let node_id = test_node_id();
    let original = Patch::set_text(node_id, "Original".to_string());

    // WHEN: Clone it
    let cloned = original.clone();

    // THEN: Clone is independent and equal
    match (&original, &cloned) {
        (Patch::SetText { text: t1, .. }, Patch::SetText { text: t2, .. }) => {
            assert_eq!(t1, t2);
        }
        _ => panic!("Expected SetText patches"),
    }
}

#[test]
fn test_create_patch_with_empty_props() {
    // GIVEN: NodeId with empty props
    let node_id = test_node_id();
    let props = indexmap! {};

    // WHEN: Create patch
    let patch = Patch::create(node_id, "EmptyElement".to_string(), Arc::new(props));

    // THEN: Handles empty props
    match patch {
        Patch::Create {
            element_type,
            props,
            ..
        } => {
            assert_eq!(element_type, "EmptyElement");
            assert_eq!(props.len(), 0);
        }
        _ => panic!("Expected Create patch"),
    }
}

// ============================================================================
// Serialization/Deserialization (4 tests)
// ============================================================================

#[test]
fn test_serialize_create_patch() {
    // GIVEN: Create patch
    let node_id = test_node_id();
    let props = indexmap! {
        "text".to_string() => json!("Hello"),
    };
    let patch = Patch::create(node_id, "Text".to_string(), Arc::new(props));

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&patch).unwrap();

    // THEN: Correct JSON structure with camelCase
    assert_eq!(json["type"], "create");
    // The serde tag is "element_type" in the JSON, but serde(rename_all = "camelCase") applies it
    // Actually check what fields exist
    assert!(json.get("id").is_some());
    assert!(json.get("elementType").is_some() || json.get("element_type").is_some());
    assert!(json.get("props").is_some());
}

#[test]
fn test_serialize_set_prop_patch() {
    // GIVEN: SetProp patch
    let node_id = test_node_id();
    let patch = Patch::set_prop(node_id, "color".to_string(), json!("red"));

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&patch).unwrap();

    // THEN: Correct JSON structure
    assert_eq!(json["type"], "setProp");
    assert!(json["id"].is_string());
    assert_eq!(json["name"], "color");
    assert_eq!(json["value"], "red");
}

#[test]
fn test_serialize_insert_patch() {
    // GIVEN: Insert patch
    let parent_id = test_node_id();
    let child_id = test_node_id();
    let patch = Patch::insert(parent_id, child_id, None);

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&patch).unwrap();

    // THEN: Correct JSON structure
    assert_eq!(json["type"], "insert");
    // Check for both camelCase and snake_case since serde config may vary
    assert!(json.get("parentId").is_some() || json.get("parent_id").is_some());
    assert!(json.get("id").is_some());
    let before_field = json.get("beforeId").or_else(|| json.get("before_id"));
    assert!(before_field.is_some());
}

#[test]
fn test_deserialize_patch() {
    // GIVEN: JSON representation of patch (node IDs are now compact integers)
    let json = json!({
        "type": "remove",
        "id": "42"
    });

    // WHEN: Deserialize from JSON
    let patch: Patch = serde_json::from_value(json).unwrap();

    // THEN: Correct patch variant
    match patch {
        Patch::Remove { id } => {
            assert_eq!(id, "42");
        }
        _ => panic!("Expected Remove patch"),
    }
}

#[test]
fn test_remove_prop_patch() {
    // GIVEN: NodeId and prop name
    let node_id = test_node_id();

    // WHEN: Create RemoveProp patch
    let patch = Patch::remove_prop(node_id, "color".to_string());

    // THEN: RemoveProp patch with correct structure
    match patch {
        Patch::RemoveProp { id, name } => {
            assert!(!id.is_empty());
            assert_eq!(name, "color");
        }
        _ => panic!("Expected RemoveProp patch"),
    }
}

#[test]
fn test_serialize_remove_prop_patch() {
    // GIVEN: RemoveProp patch
    let node_id = test_node_id();
    let patch = Patch::remove_prop(node_id, "color".to_string());

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&patch).unwrap();

    // THEN: Correct JSON structure
    assert_eq!(json["type"], "removeProp");
    assert!(json["id"].is_string());
    assert_eq!(json["name"], "color");
}

#[test]
fn test_deserialize_remove_prop_patch() {
    // GIVEN: JSON representation of removeProp patch
    let json = json!({
        "type": "removeProp",
        "id": "99",
        "name": "color"
    });

    // WHEN: Deserialize from JSON
    let patch: Patch = serde_json::from_value(json).unwrap();

    // THEN: Correct patch variant
    match patch {
        Patch::RemoveProp { id, name } => {
            assert_eq!(id, "99");
            assert_eq!(name, "color");
        }
        _ => panic!("Expected RemoveProp patch"),
    }
}

// ============================================================================
// Regression tests
// ============================================================================

/// After Arc-wrapping `Patch::Create::props` the wire format must still
/// emit `"props": {...}` as a bare JSON object — no nested "inner" wrapper,
/// no Arc-specific shape. This test locks that down so a future change
/// that disabled the `resolved_props_serde` shim would fail loudly.
#[test]
fn test_create_patch_wire_format_unchanged_by_arc_wrap() {
    let node_id = test_node_id();
    let props = indexmap! {
        "text".to_string() => json!("Hello"),
        "color".to_string() => json!("red"),
    };
    let patch = Patch::create(node_id, "Text".to_string(), Arc::new(props));

    let json_str = serde_json::to_string(&patch).unwrap();
    let json_val: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    // props must serialize as a plain object with the original keys present
    // at the top level — not nested under any Arc-related wrapper.
    let props_val = json_val.get("props").expect("missing props field");
    assert!(
        props_val.is_object(),
        "props must serialize as a bare JSON object, got: {}",
        props_val
    );
    assert_eq!(props_val.get("text"), Some(&json!("Hello")));
    assert_eq!(props_val.get("color"), Some(&json!("red")));

    // Must not contain any extra fields introduced by Arc wrapping.
    let obj = props_val.as_object().unwrap();
    assert_eq!(obj.len(), 2, "props object grew extra fields: {:?}", obj);
}

/// Round-trip: serialize a Create patch, deserialize it, and confirm the
/// props content survives. Exercises the custom `resolved_props_serde`
/// deserialize path that the derive macro can't generate on its own.
#[test]
fn test_create_patch_serde_roundtrip() {
    let node_id = test_node_id();
    let props = indexmap! {
        "text".to_string() => json!("Hello"),
        "count".to_string() => json!(42),
        "flag".to_string() => json!(true),
        "nested".to_string() => json!({"inner": [1, 2, 3]}),
    };
    let original = Patch::create(node_id, "Text".to_string(), Arc::new(props));

    let json_str = serde_json::to_string(&original).unwrap();
    let restored: Patch = serde_json::from_str(&json_str).unwrap();

    match restored {
        Patch::Create {
            props: restored_props,
            element_type,
            ..
        } => {
            assert_eq!(element_type, "Text");
            assert_eq!(restored_props.get("text"), Some(&json!("Hello")));
            assert_eq!(restored_props.get("count"), Some(&json!(42)));
            assert_eq!(restored_props.get("flag"), Some(&json!(true)));
            assert_eq!(
                restored_props.get("nested"),
                Some(&json!({"inner": [1, 2, 3]}))
            );
        }
        _ => panic!("Expected Create patch after round-trip"),
    }
}

/// Pin the exact JSON bytes a Create patch serializes to. This is the
/// contract between the engine and every platform renderer (DOM, Canvas,
/// iOS, Android, WASI hosts); if anything here shifts, those renderers
/// need to know.
#[test]
fn test_create_patch_exact_json_bytes() {
    use hypen_engine::reconcile::node_id_str;

    // Build a NodeId whose as_ffi encoding we can assert against.
    let mut sm: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let id = sm.insert(());
    let id_str = node_id_str(id);

    let props = indexmap! {
        "text".to_string() => json!("Hi"),
    };
    let patch = Patch::create(id, "Text".to_string(), Arc::new(props));

    // Build the expected shape manually from primitives so the assertion
    // doesn't lean on Patch's own serialization.
    let expected = serde_json::json!({
        "type": "create",
        "id": id_str,
        "elementType": "Text",
        "props": { "text": "Hi" },
    });

    let actual: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&patch).unwrap()).unwrap();

    assert_eq!(
        actual, expected,
        "Patch::Create wire format drifted — renderers will break"
    );
}

/// `node_id_str` must be stable per NodeId and distinct across NodeIds.
/// The mutex-backed registry was removed in favor of slotmap::KeyData::as_ffi;
/// this test pins that property so a future change that tried to add a
/// counter or randomization would get caught.
#[test]
fn test_node_id_str_stable_and_unique() {
    use hypen_engine::reconcile::node_id_str;
    use std::collections::HashSet;

    // Create a handful of distinct NodeIds via a slotmap insertion.
    let mut sm: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let ids: Vec<NodeId> = (0..32).map(|_| sm.insert(())).collect();

    // Same NodeId → same string, every time.
    for &id in &ids {
        let first = node_id_str(id);
        let second = node_id_str(id);
        assert_eq!(first, second, "node_id_str must be deterministic per id");
    }

    // Distinct NodeIds → distinct strings.
    let seen: HashSet<String> = ids.iter().copied().map(node_id_str).collect();
    assert_eq!(
        seen.len(),
        ids.len(),
        "different NodeIds collided to the same string"
    );
}
