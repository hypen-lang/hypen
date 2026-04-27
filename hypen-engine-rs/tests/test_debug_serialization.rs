/// Debug tests to understand serialization behavior
use hypen_engine::serialize::remote::{
    deserialize_message, serialize_message, InitialTree, RemoteMessage,
};
use serde_json::json;

#[test]
fn test_debug_null_payload_serialization() {
    // Test what actually gets serialized
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "test".to_string(),
        payload: Some(json!(null)),
    };

    let serialized = serialize_message(&message).unwrap();
    println!("Serialized: {}", serialized);

    let deserialized = deserialize_message(&serialized).unwrap();

    match deserialized {
        RemoteMessage::DispatchAction {
            module,
            action,
            payload,
        } => {
            println!("Module: {}", module);
            println!("Action: {}", action);
            println!("Payload is_some: {}", payload.is_some());
            if let Some(p) = payload {
                println!("Payload value: {:?}", p);
                println!("Payload is_null: {}", p.is_null());
            }
        }
        _ => panic!("Wrong variant"),
    }
}

#[test]
fn test_debug_none_payload_serialization() {
    let message = RemoteMessage::DispatchAction {
        module: "Test".to_string(),
        action: "test".to_string(),
        payload: None,
    };

    let serialized = serialize_message(&message).unwrap();
    println!("Serialized with None: {}", serialized);

    let deserialized = deserialize_message(&serialized).unwrap();

    match deserialized {
        RemoteMessage::DispatchAction { payload, .. } => {
            println!("Payload is_some: {}", payload.is_some());
        }
        _ => panic!("Wrong variant"),
    }
}

#[test]
fn test_debug_large_array_size() {
    let large_array: Vec<i32> = (0..10_000).collect();
    let state = json!({ "items": large_array });

    let tree = InitialTree::new("Test".to_string(), state, vec![]);
    let serialized = serde_json::to_string(&tree).unwrap();

    println!("Serialized length: {}", serialized.len());
    println!(
        "First 200 chars: {}",
        &serialized[..200.min(serialized.len())]
    );

    // Check what we're actually getting
    assert!(serialized.len() > 1000, "Should at least be > 1000 bytes");
}
