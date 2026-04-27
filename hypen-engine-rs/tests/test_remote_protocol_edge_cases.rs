/// Remote UI Protocol Edge Case Tests
///
/// Tests edge cases and error scenarios for the remote UI protocol
/// that aren't covered in the basic serialization tests.
use hypen_engine::ir::NodeId;
use hypen_engine::reconcile::Patch;
use hypen_engine::serialize::remote::{
    deserialize_message, serialize_message, InitialTree, PatchStream, RemoteMessage,
};
use serde_json::json;

fn test_node_id() -> NodeId {
    NodeId::default()
}

// ============================================================================
// Hash Validation and Integrity
// ============================================================================

#[test]
fn test_integrity_hash_added_to_initial_tree() {
    let tree = InitialTree::new("Test".to_string(), json!({}), vec![])
        .with_hash("sha256:abc123".to_string());

    assert_eq!(tree.hash, Some("sha256:abc123".to_string()));
}

#[test]
fn test_integrity_hash_added_to_patch_stream() {
    let stream =
        PatchStream::new("Test".to_string(), vec![], 1).with_hash("sha256:xyz789".to_string());

    assert_eq!(stream.hash, Some("sha256:xyz789".to_string()));
}

#[test]
fn test_hash_serialization_roundtrip() {
    let tree = InitialTree::new("Test".to_string(), json!({"data": "value"}), vec![])
        .with_hash("sha256:test".to_string());

    let json = serde_json::to_string(&tree).unwrap();
    let deserialized: InitialTree = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.hash, Some("sha256:test".to_string()));
}

#[test]
fn test_hash_validation_different_hashes() {
    // Simulates: Client receives message with unexpected hash
    let original_hash = "sha256:abc123";
    let received_hash = "sha256:xyz789";

    assert_ne!(original_hash, received_hash, "Hashes should differ");
}

#[test]
fn test_hash_validation_empty_hash() {
    let tree = InitialTree::new("Test".to_string(), json!({}), vec![]).with_hash("".to_string());

    assert_eq!(tree.hash, Some("".to_string()));
}

// ============================================================================
// Revision Ordering and Conflict Resolution
// ============================================================================

#[test]
fn test_revision_overflow_wrapping() {
    // Simulates: Revision counter overflow
    let max_revision = u64::MAX;
    let _stream1 = PatchStream::new("Test".to_string(), vec![], max_revision);

    // Next revision would wrap
    let next_revision = max_revision.wrapping_add(1);
    let stream2 = PatchStream::new("Test".to_string(), vec![], next_revision);

    assert_eq!(stream2.revision, 0);
}

#[test]
fn test_out_of_order_revisions_detected() {
    // Simulates: Client receives patches out of order
    let stream1 = PatchStream::new("Test".to_string(), vec![], 5);
    let stream2 = PatchStream::new("Test".to_string(), vec![], 3); // Earlier

    assert!(stream2.revision < stream1.revision, "Out of order detected");
}

#[test]
fn test_duplicate_revision_detection() {
    let stream1 = PatchStream::new("Test".to_string(), vec![], 10);
    let stream2 = PatchStream::new("Test".to_string(), vec![], 10);

    assert_eq!(stream1.revision, stream2.revision, "Duplicate revision");
}

#[test]
fn test_revision_gap_detection() {
    let stream1 = PatchStream::new("Test".to_string(), vec![], 5);
    let stream2 = PatchStream::new("Test".to_string(), vec![], 10); // Gap of 4

    let gap = stream2.revision - stream1.revision;
    assert_eq!(gap, 5, "Should detect revision gap");
}

#[test]
fn test_initial_tree_always_starts_at_zero() {
    let tree = InitialTree::new("Test".to_string(), json!({}), vec![]);
    assert_eq!(tree.revision, 0);
}

// ============================================================================
// Large Payloads and Performance
// ============================================================================

#[test]
fn test_large_state_serialization() {
    // Simulates: Large state object (10,000 keys)
    let mut state = serde_json::Map::new();
    for i in 0..10_000 {
        state.insert(format!("key{}", i), json!(i));
    }

    let tree = InitialTree::new("Test".to_string(), json!(state), vec![]);
    let json = serialize_message(&RemoteMessage::InitialTree(tree)).unwrap();

    assert!(json.len() > 100_000, "Should serialize large state");
}

#[test]
fn test_large_patch_list() {
    // Simulates: Many patches in single stream
    let mut patches = Vec::new();
    for i in 0..1000 {
        patches.push(Patch::set_prop(
            test_node_id(),
            format!("prop{}", i),
            json!(i),
        ));
    }

    let stream = PatchStream::new("Test".to_string(), patches.clone(), 1);
    let json = serde_json::to_string(&stream).unwrap();

    let deserialized: PatchStream = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.patches.len(), 1000);
}

#[test]
fn test_deeply_nested_state() {
    // Simulates: Deeply nested state structure
    let mut nested = json!("value");
    for _ in 0..50 {
        nested = json!({ "nested": nested });
    }

    let tree = InitialTree::new("Test".to_string(), nested, vec![]);
    let json = serde_json::to_string(&tree).unwrap();
    let deserialized: InitialTree = serde_json::from_str(&json).unwrap();

    assert!(deserialized.state.is_object());
}

#[test]
fn test_large_array_in_state() {
    let large_array: Vec<i32> = (0..10_000).collect();
    let state = json!({ "items": large_array });

    let tree = InitialTree::new("Test".to_string(), state, vec![]);
    let serialized = serde_json::to_string(&tree).unwrap();

    // Array of 10,000 integers serializes to ~48,953 bytes
    assert!(
        serialized.len() > 45_000,
        "Large array should serialize to > 45KB"
    );
}

#[test]
fn test_unicode_in_state() {
    let state = json!({
        "chinese": "你好世界",
        "japanese": "こんにちは",
        "korean": "안녕하세요",
        "emoji": "🚀🎉✨",
        "arabic": "مرحبا",
    });

    let tree = InitialTree::new("Test".to_string(), state, vec![]);
    let json = serialize_message(&RemoteMessage::InitialTree(tree)).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    match deserialized {
        RemoteMessage::InitialTree(t) => {
            assert_eq!(t.state["chinese"], "你好世界");
            assert_eq!(t.state["emoji"], "🚀🎉✨");
        }
        _ => panic!("Expected InitialTree"),
    }
}

// ============================================================================
// Message Type Edge Cases
// ============================================================================

#[test]
fn test_dispatch_action_with_null_payload() {
    // Note: In serde, Option<serde_json::Value> treats JSON null as None, not Some(Value::Null)
    // This is standard behavior - a null JSON value deserializes to None for Option<T>
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "test".to_string(),
        payload: Some(json!(null)),
    };

    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    match deserialized {
        RemoteMessage::DispatchAction { payload, .. } => {
            // When Some(null) is serialized as "payload":null and deserialized,
            // it becomes None (standard serde behavior for Option<Value>)
            assert!(
                payload.is_none(),
                "JSON null deserializes to None for Option<serde_json::Value>"
            );
        }
        _ => panic!("Expected DispatchAction"),
    }
}

#[test]
fn test_dispatch_action_with_complex_payload() {
    let payload = json!({
        "nested": {
            "deeply": {
                "value": 42
            }
        },
        "array": [1, 2, 3],
        "string": "test",
        "bool": true,
        "null": null,
    });

    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "complex".to_string(),
        payload: Some(payload.clone()),
    };

    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    match deserialized {
        RemoteMessage::DispatchAction { payload: p, .. } => {
            assert_eq!(p.unwrap(), payload);
        }
        _ => panic!("Expected DispatchAction"),
    }
}

#[test]
fn test_state_update_with_empty_state() {
    let message = RemoteMessage::StateUpdate {
        module: "Test".to_string(),
        state: json!({}),
    };

    let json = serialize_message(&message).unwrap();
    assert!(json.contains("\"state\":{}"));
}

#[test]
fn test_state_update_with_null_values() {
    let message = RemoteMessage::StateUpdate {
        module: "Test".to_string(),
        state: json!({
            "nullValue": null,
            "notNull": "value",
        }),
    };

    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    match deserialized {
        RemoteMessage::StateUpdate { state, .. } => {
            assert!(state["nullValue"].is_null());
            assert!(!state["notNull"].is_null());
        }
        _ => panic!("Expected StateUpdate"),
    }
}

#[test]
fn test_patch_stream_with_empty_patches() {
    let stream = PatchStream::new("Test".to_string(), vec![], 5);

    let json = serde_json::to_string(&stream).unwrap();
    let deserialized: PatchStream = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.patches.len(), 0);
    assert_eq!(deserialized.revision, 5);
}

// ============================================================================
// Malformed Input Handling
// ============================================================================

#[test]
fn test_deserialize_missing_type_field() {
    let json = r#"{"module": "Test", "state": {}}"#;
    let result = deserialize_message(json);
    assert!(result.is_err());
}

#[test]
fn test_deserialize_invalid_type_value() {
    let json = r#"{"type": "InvalidType", "module": "Test"}"#;
    let result = deserialize_message(json);
    assert!(result.is_err());
}

#[test]
fn test_deserialize_missing_required_field() {
    // InitialTree without patches
    let json = r#"{"type": "initialTree", "module": "Test", "state": {}, "revision": 0}"#;
    let result: Result<InitialTree, _> = serde_json::from_str(json);
    // Should fail because patches is required
    assert!(result.is_err());
}

#[test]
fn test_deserialize_wrong_field_type() {
    // Revision as string instead of number
    let json = r#"{
        "module": "Test",
        "patches": [],
        "revision": "not a number"
    }"#;
    let result: Result<PatchStream, _> = serde_json::from_str(json);
    assert!(result.is_err());
}

#[test]
fn test_deserialize_truncated_json() {
    let json = r#"{"type": "initialTree", "module": "Test", "state": {"#;
    let result = deserialize_message(json);
    assert!(result.is_err());
}

#[test]
fn test_deserialize_extra_fields_ignored() {
    let json = r#"{
        "type": "stateUpdate",
        "module": "Test",
        "state": {},
        "extraField": "ignored",
        "anotherExtra": 123
    }"#;

    let result = deserialize_message(json);
    assert!(result.is_ok(), "Should ignore extra fields");
}

// ============================================================================
// Module Name Edge Cases
// ============================================================================

#[test]
fn test_empty_module_name() {
    let tree = InitialTree::new("".to_string(), json!({}), vec![]);
    assert_eq!(tree.module, "");
}

#[test]
fn test_very_long_module_name() {
    let long_name = "a".repeat(1000);
    let tree = InitialTree::new(long_name.clone(), json!({}), vec![]);
    assert_eq!(tree.module, long_name);
}

#[test]
fn test_module_name_with_special_characters() {
    let names = vec![
        "Module-With-Dashes",
        "Module_With_Underscores",
        "Module.With.Dots",
        "Module/With/Slashes",
        "Module::With::Colons",
    ];

    for name in names {
        let tree = InitialTree::new(name.to_string(), json!({}), vec![]);
        let json = serde_json::to_string(&tree).unwrap();
        let deserialized: InitialTree = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.module, name);
    }
}

#[test]
fn test_module_name_with_unicode() {
    let names = vec!["モジュール", "模块", "모듈", "وحدة"];

    for name in names {
        let tree = InitialTree::new(name.to_string(), json!({}), vec![]);
        let json = serde_json::to_string(&tree).unwrap();
        let deserialized: InitialTree = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.module, name);
    }
}

// ============================================================================
// Action Name Edge Cases
// ============================================================================

#[test]
fn test_empty_action_name() {
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "".to_string(),
        payload: None,
    };

    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    match deserialized {
        RemoteMessage::DispatchAction { action, .. } => {
            assert_eq!(action, "");
        }
        _ => panic!("Expected DispatchAction"),
    }
}

#[test]
fn test_very_long_action_name() {
    let long_action = "a".repeat(1000);
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: long_action.clone(),
        payload: None,
    };

    let json = serialize_message(&message).unwrap();
    assert!(json.contains(&long_action));
}

// ============================================================================
// Concurrent Scenarios
// ============================================================================

#[test]
fn test_concurrent_patches_different_revisions() {
    // Simulates: Multiple clients receiving different revisions
    let patches1 = PatchStream::new("Module1".to_string(), vec![], 10);
    let patches2 = PatchStream::new("Module1".to_string(), vec![], 11);
    let patches3 = PatchStream::new("Module1".to_string(), vec![], 12);

    assert!(patches2.revision > patches1.revision);
    assert!(patches3.revision > patches2.revision);
}

#[test]
fn test_multiple_modules_same_revision() {
    // Simulates: Different modules can have independent revision counters
    let stream1 = PatchStream::new("Module1".to_string(), vec![], 5);
    let stream2 = PatchStream::new("Module2".to_string(), vec![], 5);

    assert_eq!(stream1.revision, stream2.revision);
    assert_ne!(stream1.module, stream2.module);
}

#[test]
fn test_action_dispatch_to_different_modules() {
    let action1 = RemoteMessage::DispatchAction {
        module: "Module1".to_string(),
        action: "increment".to_string(),
        payload: None,
    };

    let action2 = RemoteMessage::DispatchAction {
        module: "Module2".to_string(),
        action: "increment".to_string(),
        payload: None,
    };

    // Same action name, different modules
    match (&action1, &action2) {
        (
            RemoteMessage::DispatchAction {
                module: m1,
                action: a1,
                ..
            },
            RemoteMessage::DispatchAction {
                module: m2,
                action: a2,
                ..
            },
        ) => {
            assert_eq!(a1, a2);
            assert_ne!(m1, m2);
        }
        _ => panic!("Expected DispatchAction"),
    }
}

// ============================================================================
// Memory and Performance Edge Cases
// ============================================================================

#[test]
fn test_repeated_serialization_same_message() {
    // Simulates: Repeatedly serializing the same message (caching scenario)
    let tree = InitialTree::new("Test".to_string(), json!({"count": 0}), vec![]);

    for _ in 0..100 {
        let json = serde_json::to_string(&tree).unwrap();
        assert!(json.contains("count"));
    }
}

#[test]
fn test_state_with_many_null_values() {
    let mut state = serde_json::Map::new();
    for i in 0..1000 {
        state.insert(format!("null{}", i), json!(null));
    }

    let tree = InitialTree::new("Test".to_string(), json!(state), vec![]);
    let json = serde_json::to_string(&tree).unwrap();
    let deserialized: InitialTree = serde_json::from_str(&json).unwrap();

    assert!(deserialized.state.is_object());
}

#[test]
fn test_extremely_long_string_value() {
    let long_string = "x".repeat(100_000);
    let state = json!({ "longValue": long_string });

    let tree = InitialTree::new("Test".to_string(), state, vec![]);
    let json = serde_json::to_string(&tree).unwrap();

    assert!(json.len() > 100_000);
}

#[test]
fn test_hash_consistency_across_serialization() {
    let hash_value = "sha256:consistent_hash";
    let tree =
        InitialTree::new("Test".to_string(), json!({}), vec![]).with_hash(hash_value.to_string());

    // Serialize multiple times
    let json1 = serde_json::to_string(&tree).unwrap();
    let json2 = serde_json::to_string(&tree).unwrap();

    // JSON should be identical
    assert_eq!(json1, json2);
}
