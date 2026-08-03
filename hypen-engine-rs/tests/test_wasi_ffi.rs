//! Integration tests for WASI FFI patterns
//!
//! These tests verify that the FFI types and patterns used by the WASI bindings
//! work correctly for cross-language interop scenarios.

use hypen_engine::reconcile::Patch;
use hypen_engine::wasm::ffi::{
    extract_changed_paths, ActionPayload, FfiResult, ModuleConfig, ResolvedComponent,
    SparseStateUpdate,
};
use serde_json::json;

// =============================================================================
// Memory/Buffer Simulation Tests
// These simulate how a WASI host would interact with the engine
// =============================================================================

#[test]
fn test_ptr_len_json_pattern() {
    // Simulate how a WASI host would pass data:
    // 1. Serialize to JSON
    // 2. Get ptr and len
    // 3. Pass across FFI boundary
    // 4. Reconstruct on other side

    let config = ModuleConfig {
        name: "Counter".to_string(),
        actions: vec!["increment".to_string(), "decrement".to_string()],
        state_keys: vec!["count".to_string()],
        initial_state: json!({"count": 0}),
    };

    // Serialize to bytes (host side)
    let bytes = serde_json::to_vec(&config).unwrap();
    let ptr = bytes.as_ptr();
    let len = bytes.len();

    // Simulate FFI boundary crossing
    let received_bytes = unsafe { std::slice::from_raw_parts(ptr, len) };

    // Deserialize (engine side)
    let received: ModuleConfig = serde_json::from_slice(received_bytes).unwrap();

    assert_eq!(received.name, "Counter");
    assert_eq!(received.actions.len(), 2);
}

#[test]
fn test_string_buffer_pattern() {
    // Test the string buffer pattern used for patches
    let patches = vec![
        Patch::Create {
            id: "root".to_string(),
            element_type: "Column".to_string(),
            props: std::sync::Arc::new(indexmap::IndexMap::new()),
            semantics: None,
        },
        Patch::Create {
            id: "text1".to_string(),
            element_type: "Text".to_string(),
            props: std::sync::Arc::new({
                let mut map = indexmap::IndexMap::new();
                map.insert("0".to_string(), json!("Hello"));
                map
            }),
            semantics: None,
        },
        Patch::Insert {
            parent_id: "root".to_string(),
            id: "text1".to_string(),
            before_id: None,
        },
    ];

    // Write to buffer
    let json = serde_json::to_string(&patches).unwrap();
    let buffer: Vec<u8> = json.into_bytes();

    // Read from buffer
    let received_json = String::from_utf8(buffer).unwrap();
    let received: Vec<Patch> = serde_json::from_str(&received_json).unwrap();

    assert_eq!(received.len(), 3);
}

// =============================================================================
// Action Dispatch Flow Tests
// =============================================================================

#[test]
fn test_action_registration_and_dispatch() {
    // Simulate registering actions and dispatching them
    let registered_actions = ["login", "logout", "updateProfile"];

    // Simulate action dispatch from UI
    let action = ActionPayload {
        name: "login".to_string(),
        payload: json!({
            "username": "alice",
            "password": "secret123"
        }),
    };

    // Check if action is registered
    assert!(registered_actions.contains(&action.name.as_str()));

    // Serialize for host callback
    let json = serde_json::to_string(&action).unwrap();

    // Host receives and can process
    let received: ActionPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(received.payload["username"], "alice");
}

#[test]
fn test_action_with_complex_payload() {
    let action = ActionPayload {
        name: "submitOrder".to_string(),
        payload: json!({
            "items": [
                {"id": 1, "quantity": 2, "price": 9.99},
                {"id": 2, "quantity": 1, "price": 19.99}
            ],
            "shipping": {
                "method": "express",
                "address": {
                    "street": "123 Main St",
                    "city": "Anytown",
                    "zip": "12345"
                }
            },
            "payment": {
                "method": "card",
                "last4": "4242"
            }
        }),
    };

    let json = serde_json::to_string(&action).unwrap();
    let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

    // Verify complex nested structure preserved
    assert_eq!(parsed.payload["items"].as_array().unwrap().len(), 2);
    assert_eq!(parsed.payload["shipping"]["address"]["city"], "Anytown");
    assert_eq!(parsed.payload["payment"]["last4"], "4242");
}

// =============================================================================
// State Update Flow Tests
// =============================================================================

#[test]
fn test_full_state_update_flow() {
    // Initial state
    let _initial = json!({
        "user": null,
        "items": [],
        "loading": false
    });

    // State patch from host
    let patch = json!({
        "user": {
            "id": 123,
            "name": "Alice"
        },
        "loading": true
    });

    // Extract changed paths
    let changed = extract_changed_paths(&patch);

    // Verify paths extracted correctly
    assert!(changed.contains(&"user".to_string()));
    assert!(changed.contains(&"user.id".to_string()));
    assert!(changed.contains(&"user.name".to_string()));
    assert!(changed.contains(&"loading".to_string()));

    // items was not in patch
    assert!(!changed.contains(&"items".to_string()));
}

#[test]
fn test_sparse_state_update_flow() {
    // Sparse update is more efficient for targeted changes
    let update = SparseStateUpdate {
        paths: vec![
            "user.preferences.theme".to_string(),
            "user.preferences.language".to_string(),
        ],
        values: json!({
            "user.preferences.theme": "dark",
            "user.preferences.language": "en"
        }),
    };

    let json = serde_json::to_string(&update).unwrap();
    let received: SparseStateUpdate = serde_json::from_str(&json).unwrap();

    // Only the specified paths should be marked for update
    assert_eq!(received.paths.len(), 2);
    assert!(received
        .paths
        .iter()
        .all(|p| p.starts_with("user.preferences")));
}

// =============================================================================
// Component Resolution Tests
// =============================================================================

#[test]
fn test_component_resolution_flow() {
    // Simulate component resolver returning component info
    let resolved = ResolvedComponent {
        source: r#"Column {
            Text("Welcome")
            Button("Click me") {
                Text("Press")
            }
        }"#
        .to_string(),
        path: "/app/components/Welcome.hypen".to_string(),
        passthrough: false,
        lazy: false,
        is_module: false,
    };

    let json = serde_json::to_string(&resolved).unwrap();
    let parsed: ResolvedComponent = serde_json::from_str(&json).unwrap();

    assert!(parsed.source.contains("Column"));
    assert!(parsed.source.contains("Button"));
    assert!(!parsed.passthrough);
    assert!(!parsed.lazy);
}

#[test]
fn test_lazy_component_resolution() {
    // Lazy components are resolved but not parsed until needed
    let lazy_component = ResolvedComponent {
        source: String::new(), // Source not needed for lazy
        path: "/app/pages/Dashboard.hypen".to_string(),
        passthrough: false,
        lazy: true,
        is_module: false,
    };

    let json = serde_json::to_string(&lazy_component).unwrap();
    let parsed: ResolvedComponent = serde_json::from_str(&json).unwrap();

    assert!(parsed.lazy);
    assert!(parsed.source.is_empty());
}

#[test]
fn test_passthrough_component_resolution() {
    // Passthrough components preserve structure (like Router, Route)
    let passthrough = ResolvedComponent {
        source: String::new(),
        path: "/hypen/Router".to_string(),
        passthrough: true,
        lazy: false,
        is_module: false,
    };

    let json = serde_json::to_string(&passthrough).unwrap();
    let parsed: ResolvedComponent = serde_json::from_str(&json).unwrap();

    assert!(parsed.passthrough);
    assert!(!parsed.lazy);
}

// =============================================================================
// Error Handling Tests
// =============================================================================

#[test]
fn test_ffi_error_propagation() {
    // Test that errors serialize correctly for cross-language handling
    let parse_error: FfiResult<String> = FfiResult::Error {
        message: "Parse error at line 10, column 5: unexpected '}'".to_string(),
    };

    let json = serde_json::to_string(&parse_error).unwrap();

    // Verify JSON structure for host-side parsing
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["status"], "error");
    assert!(value["message"].as_str().unwrap().contains("line 10"));
}

#[test]
fn test_ffi_success_with_data() {
    // Test successful result with complex data
    let success: FfiResult<Vec<String>> = FfiResult::Ok {
        value: vec!["patch1".to_string(), "patch2".to_string()],
    };

    let json = serde_json::to_string(&success).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(value["status"], "ok");
    assert!(value["value"].is_array());
    assert_eq!(value["value"].as_array().unwrap().len(), 2);
}

// =============================================================================
// Patch Generation Tests
// =============================================================================

#[test]
fn test_patch_serialization_all_types() {
    // Test all patch types serialize correctly
    // Note: Event attachment/detachment is handled at the renderer level, not via patches
    let patches = vec![
        Patch::Create {
            id: "node1".to_string(),
            element_type: "Text".to_string(),
            props: std::sync::Arc::new({
                let mut map = indexmap::IndexMap::new();
                map.insert("0".to_string(), json!("Hello"));
                map
            }),
            semantics: None,
        },
        Patch::SetProp {
            id: "node1".to_string(),
            name: "color".to_string(),
            value: json!("red"),
        },
        Patch::SetText {
            id: "node1".to_string(),
            text: "Updated text".to_string(),
        },
        Patch::Insert {
            parent_id: "root".to_string(),
            id: "node1".to_string(),
            before_id: None,
        },
        Patch::Move {
            parent_id: "root".to_string(),
            id: "node1".to_string(),
            before_id: Some("node2".to_string()),
        },
        Patch::Remove {
            id: "node1".to_string(),
        },
    ];

    let json = serde_json::to_string(&patches).unwrap();
    let parsed: Vec<Patch> = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.len(), 6);

    // Verify each patch type
    assert!(matches!(&parsed[0], Patch::Create { .. }));
    assert!(matches!(&parsed[1], Patch::SetProp { .. }));
    assert!(matches!(&parsed[2], Patch::SetText { .. }));
    assert!(matches!(&parsed[3], Patch::Insert { .. }));
    assert!(matches!(&parsed[4], Patch::Move { .. }));
    assert!(matches!(&parsed[5], Patch::Remove { .. }));
}

// =============================================================================
// Cross-Language Compatibility Tests
// =============================================================================

#[test]
fn test_json_compatibility_with_go() {
    // Go typically expects snake_case or camelCase
    // Verify our JSON works with common Go patterns
    let config_json = r#"{
        "name": "MyModule",
        "actions": ["action1"],
        "state_keys": ["key1"],
        "initial_state": {"key1": null}
    }"#;

    let config: ModuleConfig = serde_json::from_str(config_json).unwrap();
    assert_eq!(config.name, "MyModule");
}

#[test]
fn test_json_compatibility_with_python() {
    // Python dicts serialize similarly to JSON objects
    let action_json = r#"{"name": "click", "payload": {"x": 100, "y": 200}}"#;

    let action: ActionPayload = serde_json::from_str(action_json).unwrap();
    assert_eq!(action.name, "click");
    assert_eq!(action.payload["x"], 100);
}

#[test]
fn test_null_handling() {
    // Verify null values are handled correctly across FFI
    let config = ModuleConfig {
        name: "NullTest".to_string(),
        actions: vec![],
        state_keys: vec![],
        initial_state: json!({
            "nullable": null,
            "present": "value"
        }),
    };

    let json = serde_json::to_string(&config).unwrap();
    let parsed: ModuleConfig = serde_json::from_str(&json).unwrap();

    assert!(parsed.initial_state["nullable"].is_null());
    assert!(!parsed.initial_state["present"].is_null());
}

#[test]
fn test_unicode_handling() {
    // Test unicode strings work correctly across FFI
    let action = ActionPayload {
        name: "sendMessage".to_string(),
        payload: json!({
            "text": "Hello 世界! 🎉",
            "recipient": "用户名"
        }),
    };

    let json = serde_json::to_string(&action).unwrap();
    let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

    assert!(parsed.payload["text"].as_str().unwrap().contains("世界"));
    assert!(parsed.payload["text"].as_str().unwrap().contains("🎉"));
}

#[test]
fn test_large_payload_handling() {
    // Test handling of larger payloads
    let items: Vec<serde_json::Value> = (0..1000)
        .map(|i| {
            json!({
                "id": i,
                "name": format!("Item {}", i),
                "data": vec![i; 10]
            })
        })
        .collect();

    let action = ActionPayload {
        name: "bulkUpdate".to_string(),
        payload: json!({ "items": items }),
    };

    let json = serde_json::to_string(&action).unwrap();
    let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.payload["items"].as_array().unwrap().len(), 1000);
}

// =============================================================================
// WASI Error Code Contract
// =============================================================================

/// Verify that FfiResult correctly distinguishes errors from successes.
/// The WASI layer returns integer error codes (1-4) and stores the full
/// error message in a thread-local buffer readable via hypen_get_last_error.
/// This test validates the error contract at the type level.
#[test]
fn test_wasi_error_code_contract() {
    // Error code 1: invalid pointer / UTF-8 error
    // Simulated by providing garbage bytes that aren't valid UTF-8
    let bad_utf8: Vec<u8> = vec![0xFF, 0xFE];
    assert!(
        std::str::from_utf8(&bad_utf8).is_err(),
        "Code 1 scenario: invalid UTF-8"
    );

    // Error code 2: invalid JSON / deserialization failure
    let bad_json = "{ not valid json }";
    assert!(
        serde_json::from_str::<ModuleConfig>(bad_json).is_err(),
        "Code 2 scenario: invalid JSON"
    );

    // Error code 3: parse error - verified through parser
    let bad_source = "Column { broken !!!";
    assert!(
        hypen_parser::parse_component(bad_source).is_err(),
        "Code 3 scenario: parse error"
    );

    // Verify that FfiResult::Error serializes properly for host-side decoding
    let err: FfiResult<()> = FfiResult::Error {
        message: "hypen_render_source: parse error: unexpected token".to_string(),
    };
    let json = serde_json::to_string(&err).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["status"], "error");
    assert!(
        value["message"].as_str().unwrap().contains("parse error"),
        "Error message should contain diagnostic info"
    );
}

/// Verify that error messages from the engine contain enough context for debugging.
#[test]
fn test_error_messages_are_descriptive() {
    use hypen_engine::EngineError;

    // EngineError::ParseError includes both source snippet and message
    let err = EngineError::ParseError {
        source: "Column { broken".to_string(),
        message: "unexpected end of input".to_string(),
    };
    let display = err.to_string();
    assert!(
        display.contains("Column { broken"),
        "Should include source snippet"
    );
    assert!(
        display.contains("unexpected end of input"),
        "Should include error detail"
    );

    // EngineError::StateError includes context
    let err = EngineError::StateError("invalid JSON: expected '{' at line 1".to_string());
    assert!(err.to_string().contains("invalid JSON"));
}
