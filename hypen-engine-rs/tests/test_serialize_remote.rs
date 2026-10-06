//! Tests for src/serialize/remote.rs - Remote UI protocol
//!
//! Tests serialization/deserialization of messages for remote UI streaming

use hypen_engine::ir::NodeId;
use hypen_engine::reconcile::Patch;
use hypen_engine::serialize::remote::{
    deserialize_message, serialize_message, InitialTree, PatchStream, RemoteMessage,
};
use serde_json::json;

// Helper to create test NodeId
fn test_node_id() -> NodeId {
    NodeId::default()
}

// ============================================================================
// InitialTree Serialization/Deserialization (5 tests)
// ============================================================================

#[test]
fn test_initial_tree_new() {
    // GIVEN: Module, state, and patches
    let state = json!({"count": 0, "user": "Alice"});
    let patches = vec![Patch::create(
        test_node_id(),
        "Column".to_string(),
        std::sync::Arc::new(indexmap::indexmap! {}),
        None,
    )];

    // WHEN: Create InitialTree
    let tree = InitialTree::new("Counter".to_string(), state.clone(), patches.clone());

    // THEN: Fields set correctly
    assert_eq!(tree.module, "Counter");
    assert_eq!(tree.state, state);
    assert_eq!(tree.patches.len(), 1);
    assert_eq!(tree.revision, 0);
    assert_eq!(tree.hash, None);
}

#[test]
fn test_initial_tree_with_hash() {
    // GIVEN: InitialTree
    let tree = InitialTree::new("Test".to_string(), json!({}), vec![]);

    // WHEN: Add hash
    let tree_with_hash = tree.with_hash("abc123".to_string());

    // THEN: Hash added
    assert_eq!(tree_with_hash.hash, Some("abc123".to_string()));
}

#[test]
fn test_initial_tree_serialization() {
    // GIVEN: InitialTree with state and patches
    let tree = InitialTree::new(
        "UserModule".to_string(),
        json!({"name": "Alice", "email": "alice@example.com"}),
        vec![Patch::create(
            test_node_id(),
            "Text".to_string(),
            std::sync::Arc::new(indexmap::indexmap! {}),
            None,
        )],
    );

    // WHEN: Serialize to JSON
    let json_str = serde_json::to_string(&tree).unwrap();

    // THEN: Contains all fields
    assert!(json_str.contains("UserModule"));
    assert!(json_str.contains("Alice"));
    assert!(json_str.contains("alice@example.com"));
    assert!(json_str.contains("revision"));
}

#[test]
fn test_initial_tree_deserialization() {
    // GIVEN: JSON representation
    let json_str = r#"{
        "module": "Counter",
        "state": {"count": 5},
        "patches": [],
        "revision": 0
    }"#;

    // WHEN: Deserialize from JSON
    let tree: InitialTree = serde_json::from_str(json_str).unwrap();

    // THEN: Correctly parsed
    assert_eq!(tree.module, "Counter");
    assert_eq!(tree.state["count"], 5);
    assert_eq!(tree.patches.len(), 0);
    assert_eq!(tree.revision, 0);
    assert_eq!(tree.hash, None);
}

#[test]
fn test_initial_tree_hash_omitted_when_none() {
    // GIVEN: InitialTree without hash
    let tree = InitialTree::new("Test".to_string(), json!({}), vec![]);

    // WHEN: Serialize
    let json_str = serde_json::to_string(&tree).unwrap();

    // THEN: Hash field not included (skip_serializing_if)
    assert!(!json_str.contains("hash"));
}

// ============================================================================
// PatchStream with Revision Tracking (5 tests)
// ============================================================================

#[test]
fn test_patch_stream_new() {
    // GIVEN: Module, patches, and revision
    let patches = vec![Patch::set_prop(
        test_node_id(),
        "count".to_string(),
        json!(10),
    )];

    // WHEN: Create PatchStream
    let stream = PatchStream::new("Counter".to_string(), patches.clone(), 5);

    // THEN: Fields set correctly
    assert_eq!(stream.module, "Counter");
    assert_eq!(stream.patches.len(), 1);
    assert_eq!(stream.revision, 5);
    assert_eq!(stream.hash, None);
}

#[test]
fn test_patch_stream_with_hash() {
    // GIVEN: PatchStream
    let stream = PatchStream::new("Test".to_string(), vec![], 1);

    // WHEN: Add hash
    let stream_with_hash = stream.with_hash("xyz789".to_string());

    // THEN: Hash added
    assert_eq!(stream_with_hash.hash, Some("xyz789".to_string()));
}

#[test]
fn test_patch_stream_serialization() {
    // GIVEN: PatchStream with patches
    let stream = PatchStream::new(
        "Counter".to_string(),
        vec![Patch::set_prop(
            test_node_id(),
            "count".to_string(),
            json!(15),
        )],
        3,
    );

    // WHEN: Serialize to JSON
    let json_str = serde_json::to_string(&stream).unwrap();

    // THEN: Contains all fields
    assert!(json_str.contains("Counter"));
    assert!(json_str.contains("revision"));
    assert!(json_str.contains("3"));
}

#[test]
fn test_patch_stream_deserialization() {
    // GIVEN: JSON representation
    let json_str = r#"{
        "module": "UserProfile",
        "patches": [],
        "revision": 10
    }"#;

    // WHEN: Deserialize from JSON
    let stream: PatchStream = serde_json::from_str(json_str).unwrap();

    // THEN: Correctly parsed
    assert_eq!(stream.module, "UserProfile");
    assert_eq!(stream.patches.len(), 0);
    assert_eq!(stream.revision, 10);
    assert_eq!(stream.hash, None);
}

#[test]
fn test_patch_stream_revision_monotonically_increasing() {
    // GIVEN: Multiple patch streams
    let stream1 = PatchStream::new("Test".to_string(), vec![], 1);
    let stream2 = PatchStream::new("Test".to_string(), vec![], 2);
    let stream3 = PatchStream::new("Test".to_string(), vec![], 3);

    // THEN: Revisions increase monotonically
    assert!(stream2.revision > stream1.revision);
    assert!(stream3.revision > stream2.revision);
}

// ============================================================================
// RemoteMessage Variants (5 tests)
// ============================================================================

#[test]
fn test_remote_message_initial_tree() {
    // GIVEN: InitialTree message
    let tree = InitialTree::new("Test".to_string(), json!({"count": 0}), vec![]);
    let message = RemoteMessage::InitialTree(tree);

    // WHEN: Serialize and deserialize
    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    // THEN: Correct type and data preserved
    match deserialized {
        RemoteMessage::InitialTree(t) => {
            assert_eq!(t.module, "Test");
            assert_eq!(t.state["count"], 0);
        }
        _ => panic!("Expected InitialTree variant"),
    }
}

#[test]
fn test_remote_message_patch() {
    // GIVEN: Patch message
    let stream = PatchStream::new("Counter".to_string(), vec![], 5);
    let message = RemoteMessage::Patch(stream);

    // WHEN: Serialize and deserialize
    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    // THEN: Correct type and data preserved
    match deserialized {
        RemoteMessage::Patch(s) => {
            assert_eq!(s.module, "Counter");
            assert_eq!(s.revision, 5);
        }
        _ => panic!("Expected Patch variant"),
    }
}

#[test]
fn test_remote_message_dispatch_action() {
    // GIVEN: DispatchAction message
    let message = RemoteMessage::DispatchAction {
        module: "Counter".to_string(),
        action: "increment".to_string(),
        payload: Some(json!({"amount": 5})),
    };

    // WHEN: Serialize and deserialize
    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    // THEN: Correct type and data preserved
    match deserialized {
        RemoteMessage::DispatchAction {
            module,
            action,
            payload,
        } => {
            assert_eq!(module, "Counter");
            assert_eq!(action, "increment");
            assert_eq!(payload.unwrap()["amount"], 5);
        }
        _ => panic!("Expected DispatchAction variant"),
    }
}

#[test]
fn test_remote_message_state_update() {
    // GIVEN: StateUpdate message
    let message = RemoteMessage::StateUpdate {
        module: "User".to_string(),
        state: json!({"name": "Bob", "age": 25}),
    };

    // WHEN: Serialize and deserialize
    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    // THEN: Correct type and data preserved
    match deserialized {
        RemoteMessage::StateUpdate { module, state } => {
            assert_eq!(module, "User");
            assert_eq!(state["name"], "Bob");
            assert_eq!(state["age"], 25);
        }
        _ => panic!("Expected StateUpdate variant"),
    }
}

#[test]
fn test_remote_message_dispatch_action_without_payload() {
    // GIVEN: DispatchAction without payload
    let message = RemoteMessage::DispatchAction {
        module: "Auth".to_string(),
        action: "logout".to_string(),
        payload: None,
    };

    // WHEN: Serialize and deserialize
    let json = serialize_message(&message).unwrap();
    let deserialized = deserialize_message(&json).unwrap();

    // THEN: Payload is None
    match deserialized {
        RemoteMessage::DispatchAction {
            module,
            action,
            payload,
        } => {
            assert_eq!(module, "Auth");
            assert_eq!(action, "logout");
            assert!(payload.is_none());
        }
        _ => panic!("Expected DispatchAction variant"),
    }
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_message_type_field_camelcase() {
    // GIVEN: Any RemoteMessage
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "test".to_string(),
        payload: None,
    };

    // WHEN: Serialize
    let json = serialize_message(&message).unwrap();

    // THEN: Type field is camelCase (dispatchAction not dispatch_action)
    assert!(json.contains("\"type\""));
    assert!(json.contains("dispatchAction"));
}

#[test]
fn test_serialize_deserialize_roundtrip_all_variants() {
    // GIVEN: All RemoteMessage variants
    let messages = vec![
        RemoteMessage::InitialTree(InitialTree::new("M1".to_string(), json!({}), vec![])),
        RemoteMessage::Patch(PatchStream::new("M2".to_string(), vec![], 1)),
        RemoteMessage::DispatchAction {
            module: "M3".to_string(),
            action: "act".to_string(),
            payload: Some(json!({"x": 1})),
        },
        RemoteMessage::StateUpdate {
            module: "M4".to_string(),
            state: json!({"y": 2}),
        },
    ];

    // WHEN: Serialize and deserialize each
    for message in messages {
        let json = serialize_message(&message).unwrap();
        let deserialized = deserialize_message(&json).unwrap();

        // THEN: Variants match
        match (&message, &deserialized) {
            (RemoteMessage::InitialTree(_), RemoteMessage::InitialTree(_)) => {}
            (RemoteMessage::Patch(_), RemoteMessage::Patch(_)) => {}
            (RemoteMessage::DispatchAction { .. }, RemoteMessage::DispatchAction { .. }) => {}
            (RemoteMessage::StateUpdate { .. }, RemoteMessage::StateUpdate { .. }) => {}
            _ => panic!("Variant mismatch after roundtrip"),
        }
    }
}

#[test]
fn test_deserialize_invalid_json_returns_error() {
    // GIVEN: Invalid JSON
    let invalid_json = "{ not valid json }";

    // WHEN: Try to deserialize
    let result = deserialize_message(invalid_json);

    // THEN: Returns error
    assert!(result.is_err());
}

#[test]
fn test_initial_tree_with_multiple_patches() {
    // GIVEN: InitialTree with multiple patches
    let patches = vec![
        Patch::create(
            test_node_id(),
            "Column".to_string(),
            std::sync::Arc::new(indexmap::indexmap! {}),
            None,
        ),
        Patch::insert(test_node_id(), test_node_id(), None),
        Patch::set_text(test_node_id(), "Hello".to_string()),
    ];
    let tree = InitialTree::new("App".to_string(), json!({}), patches);

    // WHEN: Serialize and deserialize
    let json = serde_json::to_string(&tree).unwrap();
    let deserialized: InitialTree = serde_json::from_str(&json).unwrap();

    // THEN: All patches preserved
    assert_eq!(deserialized.patches.len(), 3);
}
