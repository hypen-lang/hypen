//! Shared FFI utilities for WASM bindings
//!
//! This module contains helpers and types used by both JS and WASI bindings.

use serde::{Deserialize, Serialize};

use crate::error::EngineError;

/// Extract changed paths from a state patch JSON value
pub fn extract_changed_paths(patch: &serde_json::Value) -> Vec<String> {
    let mut paths = Vec::new();
    extract_paths_recursive(patch, String::new(), &mut paths);
    paths
}

fn extract_paths_recursive(value: &serde_json::Value, prefix: String, paths: &mut Vec<String>) {
    if let serde_json::Value::Object(map) = value {
        for (key, val) in map {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{}.{}", prefix, key)
            };
            paths.push(path.clone());
            extract_paths_recursive(val, path, paths);
        }
    }
}

/// Result type for FFI operations that can be serialized
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum FfiResult<T> {
    #[serde(rename = "ok")]
    Ok { value: T },
    #[serde(rename = "error")]
    Error { message: String },
}

impl<T> From<Result<T, String>> for FfiResult<T> {
    fn from(result: Result<T, String>) -> Self {
        match result {
            Ok(value) => FfiResult::Ok { value },
            Err(message) => FfiResult::Error { message },
        }
    }
}

impl<T> From<Result<T, EngineError>> for FfiResult<T> {
    fn from(result: Result<T, EngineError>) -> Self {
        match result {
            Ok(value) => FfiResult::Ok { value },
            Err(err) => FfiResult::Error {
                message: err.to_string(),
            },
        }
    }
}

/// Module configuration for initialization
#[derive(Debug, Serialize, Deserialize)]
pub struct ModuleConfig {
    pub name: String,
    pub actions: Vec<String>,
    pub state_keys: Vec<String>,
    pub initial_state: serde_json::Value,
}

/// Component resolution result
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedComponent {
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub passthrough: bool,
    #[serde(default)]
    pub lazy: bool,
    #[serde(default)]
    pub is_module: bool,
}

/// Action payload for dispatching
#[derive(Debug, Serialize, Deserialize)]
pub struct ActionPayload {
    pub name: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Sparse state update request
#[derive(Debug, Serialize, Deserialize)]
pub struct SparseStateUpdate {
    pub paths: Vec<String>,
    pub values: serde_json::Value,
    /// Optional batch-animation context (Option D cheap subset): a spec
    /// object or a bare curve string. Absent from the envelope → unstamped
    /// update (backward compatible with pre-animation hosts). Skipped on
    /// serialize when `None` so round-trips stay byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // =========================================================================
    // Path Extraction Tests
    // =========================================================================

    #[test]
    fn test_extract_changed_paths_nested() {
        let patch = json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"user".to_string()));
        assert!(paths.contains(&"user.name".to_string()));
        assert!(paths.contains(&"user.age".to_string()));
    }

    #[test]
    fn test_extract_changed_paths_flat() {
        let patch = json!({
            "count": 42,
            "name": "test"
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"count".to_string()));
        assert!(paths.contains(&"name".to_string()));
        assert_eq!(paths.len(), 2);
    }

    #[test]
    fn test_extract_changed_paths_deeply_nested() {
        let patch = json!({
            "a": {
                "b": {
                    "c": {
                        "d": "value"
                    }
                }
            }
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"a".to_string()));
        assert!(paths.contains(&"a.b".to_string()));
        assert!(paths.contains(&"a.b.c".to_string()));
        assert!(paths.contains(&"a.b.c.d".to_string()));
    }

    #[test]
    fn test_extract_changed_paths_empty() {
        let patch = json!({});
        let paths = extract_changed_paths(&patch);
        assert!(paths.is_empty());
    }

    #[test]
    fn test_extract_changed_paths_primitive() {
        let patch = json!(42);
        let paths = extract_changed_paths(&patch);
        assert!(paths.is_empty()); // Root primitive has no path
    }

    #[test]
    fn test_extract_changed_paths_array() {
        let patch = json!({
            "items": [1, 2, 3]
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"items".to_string()));
        // Arrays are treated as leaf values, not traversed
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn test_extract_changed_paths_mixed_types() {
        let patch = json!({
            "string_val": "hello",
            "number_val": 42,
            "bool_val": true,
            "null_val": null,
            "array_val": [1, 2],
            "nested": {"key": "value"}
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"string_val".to_string()));
        assert!(paths.contains(&"number_val".to_string()));
        assert!(paths.contains(&"bool_val".to_string()));
        assert!(paths.contains(&"null_val".to_string()));
        assert!(paths.contains(&"array_val".to_string()));
        assert!(paths.contains(&"nested".to_string()));
        assert!(paths.contains(&"nested.key".to_string()));
        assert_eq!(paths.len(), 7);
    }

    #[test]
    fn test_extract_changed_paths_special_characters_in_keys() {
        let patch = json!({
            "key-with-dash": 1,
            "key_with_underscore": 2,
            "key.with.dots": 3
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"key-with-dash".to_string()));
        assert!(paths.contains(&"key_with_underscore".to_string()));
        assert!(paths.contains(&"key.with.dots".to_string()));
    }

    #[test]
    fn test_extract_changed_paths_unicode_keys() {
        let patch = json!({
            "日本語": "value",
            "emoji🎉": "party"
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"日本語".to_string()));
        assert!(paths.contains(&"emoji🎉".to_string()));
    }

    #[test]
    fn test_extract_changed_paths_numeric_string_keys() {
        let patch = json!({
            "0": "first",
            "1": "second",
            "100": "hundredth"
        });

        let paths = extract_changed_paths(&patch);
        assert!(paths.contains(&"0".to_string()));
        assert!(paths.contains(&"1".to_string()));
        assert!(paths.contains(&"100".to_string()));
    }

    // =========================================================================
    // FfiResult Tests
    // =========================================================================

    #[test]
    fn test_ffi_result_ok_serialization() {
        let ok_result: FfiResult<i32> = FfiResult::Ok { value: 42 };
        let json = serde_json::to_string(&ok_result).unwrap();
        assert!(json.contains("\"status\":\"ok\""));
        assert!(json.contains("\"value\":42"));
    }

    #[test]
    fn test_ffi_result_error_serialization() {
        let err_result: FfiResult<i32> = FfiResult::Error {
            message: "Something went wrong".to_string(),
        };
        let json = serde_json::to_string(&err_result).unwrap();
        assert!(json.contains("\"status\":\"error\""));
        assert!(json.contains("Something went wrong"));
    }

    #[test]
    fn test_ffi_result_from_result_ok() {
        let result: Result<String, String> = Ok("success".to_string());
        let ffi_result: FfiResult<String> = result.into();
        match ffi_result {
            FfiResult::Ok { value } => assert_eq!(value, "success"),
            FfiResult::Error { .. } => panic!("Expected Ok"),
        }
    }

    #[test]
    fn test_ffi_result_from_result_err() {
        let result: Result<String, String> = Err("failure".to_string());
        let ffi_result: FfiResult<String> = result.into();
        match ffi_result {
            FfiResult::Ok { .. } => panic!("Expected Error"),
            FfiResult::Error { message } => assert_eq!(message, "failure"),
        }
    }

    #[test]
    fn test_ffi_result_roundtrip() {
        let original: FfiResult<Vec<i32>> = FfiResult::Ok {
            value: vec![1, 2, 3],
        };
        let json = serde_json::to_string(&original).unwrap();
        let parsed: FfiResult<Vec<i32>> = serde_json::from_str(&json).unwrap();
        match parsed {
            FfiResult::Ok { value } => assert_eq!(value, vec![1, 2, 3]),
            FfiResult::Error { .. } => panic!("Expected Ok"),
        }
    }

    #[test]
    fn test_ffi_result_with_complex_value() {
        #[derive(Debug, Serialize, Deserialize, PartialEq)]
        struct ComplexData {
            id: u32,
            name: String,
            tags: Vec<String>,
        }

        let data = ComplexData {
            id: 123,
            name: "test".to_string(),
            tags: vec!["a".to_string(), "b".to_string()],
        };

        let result: FfiResult<ComplexData> = FfiResult::Ok { value: data };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: FfiResult<ComplexData> = serde_json::from_str(&json).unwrap();

        match parsed {
            FfiResult::Ok { value } => {
                assert_eq!(value.id, 123);
                assert_eq!(value.name, "test");
                assert_eq!(value.tags, vec!["a", "b"]);
            }
            FfiResult::Error { .. } => panic!("Expected Ok"),
        }
    }

    #[test]
    fn test_ffi_result_error_with_special_chars() {
        let err: FfiResult<()> = FfiResult::Error {
            message: "Error: \"quotes\" and 'apostrophes' and\nnewlines".to_string(),
        };
        let json = serde_json::to_string(&err).unwrap();
        let parsed: FfiResult<()> = serde_json::from_str(&json).unwrap();

        match parsed {
            FfiResult::Error { message } => {
                assert!(message.contains("quotes"));
                assert!(message.contains("newlines"));
            }
            FfiResult::Ok { .. } => panic!("Expected Error"),
        }
    }

    // =========================================================================
    // ModuleConfig Tests
    // =========================================================================

    #[test]
    fn test_module_config_serialization() {
        let config = ModuleConfig {
            name: "TestModule".to_string(),
            actions: vec!["action1".to_string(), "action2".to_string()],
            state_keys: vec!["count".to_string(), "name".to_string()],
            initial_state: json!({"count": 0, "name": ""}),
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"name\":\"TestModule\""));
        assert!(json.contains("\"actions\""));
        assert!(json.contains("\"action1\""));
    }

    #[test]
    fn test_module_config_deserialization() {
        let json = r#"{
            "name": "MyModule",
            "actions": ["submit", "cancel"],
            "state_keys": ["value"],
            "initial_state": {"value": 100}
        }"#;

        let config: ModuleConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.name, "MyModule");
        assert_eq!(config.actions, vec!["submit", "cancel"]);
        assert_eq!(config.state_keys, vec!["value"]);
        assert_eq!(config.initial_state["value"], 100);
    }

    #[test]
    fn test_module_config_empty_collections() {
        let config = ModuleConfig {
            name: "EmptyModule".to_string(),
            actions: vec![],
            state_keys: vec![],
            initial_state: json!({}),
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: ModuleConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "EmptyModule");
        assert!(parsed.actions.is_empty());
        assert!(parsed.state_keys.is_empty());
        assert!(parsed.initial_state.is_object());
    }

    #[test]
    fn test_module_config_complex_initial_state() {
        let config = ModuleConfig {
            name: "ComplexModule".to_string(),
            actions: vec!["update".to_string()],
            state_keys: vec!["user".to_string(), "items".to_string()],
            initial_state: json!({
                "user": {
                    "id": null,
                    "name": "",
                    "settings": {
                        "theme": "dark",
                        "notifications": true
                    }
                },
                "items": [],
                "count": 0
            }),
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: ModuleConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.initial_state["user"]["settings"]["theme"], "dark");
        assert!(parsed.initial_state["user"]["id"].is_null());
        assert!(parsed.initial_state["items"].is_array());
    }

    // =========================================================================
    // ResolvedComponent Tests
    // =========================================================================

    #[test]
    fn test_resolved_component_defaults() {
        let json = r#"{
            "source": "Text(\"Hello\")",
            "path": "/components/Hello.hypen"
        }"#;

        let component: ResolvedComponent = serde_json::from_str(json).unwrap();
        assert_eq!(component.source, "Text(\"Hello\")");
        assert_eq!(component.path, "/components/Hello.hypen");
        assert!(!component.passthrough); // Default false
        assert!(!component.lazy); // Default false
    }

    #[test]
    fn test_resolved_component_with_flags() {
        let component = ResolvedComponent {
            source: "".to_string(),
            path: "/lazy/Component.hypen".to_string(),
            passthrough: false,
            lazy: true,
            is_module: false,
        };

        let json = serde_json::to_string(&component).unwrap();
        assert!(json.contains("\"lazy\":true"));
    }

    #[test]
    fn test_resolved_component_passthrough() {
        let component = ResolvedComponent {
            source: String::new(),
            path: "/components/Router.hypen".to_string(),
            passthrough: true,
            lazy: false,
            is_module: false,
        };

        let json = serde_json::to_string(&component).unwrap();
        let parsed: ResolvedComponent = serde_json::from_str(&json).unwrap();

        assert!(parsed.passthrough);
        assert!(!parsed.lazy);
        assert!(parsed.source.is_empty());
    }

    #[test]
    fn test_resolved_component_complex_source() {
        let source = r#"Column {
    Text("Header")
    Row {
        Button("Submit") { Text("OK") }
        Button("Cancel") { Text("No") }
    }
}"#;
        let component = ResolvedComponent {
            source: source.to_string(),
            path: "/components/Form.hypen".to_string(),
            passthrough: false,
            lazy: false,
            is_module: false,
        };

        let json = serde_json::to_string(&component).unwrap();
        let parsed: ResolvedComponent = serde_json::from_str(&json).unwrap();

        assert!(parsed.source.contains("Column"));
        assert!(parsed.source.contains("Button"));
    }

    // =========================================================================
    // ActionPayload Tests
    // =========================================================================

    #[test]
    fn test_action_payload_minimal() {
        let json = r#"{"name": "click"}"#;
        let action: ActionPayload = serde_json::from_str(json).unwrap();
        assert_eq!(action.name, "click");
        assert!(action.payload.is_null()); // Default
    }

    #[test]
    fn test_action_payload_with_data() {
        let action = ActionPayload {
            name: "submit".to_string(),
            payload: json!({"form": {"email": "test@example.com"}}),
        };

        let json = serde_json::to_string(&action).unwrap();
        let parsed: ActionPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "submit");
        assert_eq!(parsed.payload["form"]["email"], "test@example.com");
    }

    #[test]
    fn test_action_payload_with_array() {
        let action = ActionPayload {
            name: "selectItems".to_string(),
            payload: json!({
                "ids": [1, 2, 3, 4, 5],
                "selectAll": true
            }),
        };

        let json = serde_json::to_string(&action).unwrap();
        let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.payload["ids"].as_array().unwrap().len(), 5);
        assert_eq!(parsed.payload["selectAll"], true);
    }

    #[test]
    fn test_action_payload_with_primitive_payload() {
        let action = ActionPayload {
            name: "setCount".to_string(),
            payload: json!(42),
        };

        let json = serde_json::to_string(&action).unwrap();
        let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.payload, 42);
    }

    #[test]
    fn test_action_payload_roundtrip() {
        let original = ActionPayload {
            name: "complexAction".to_string(),
            payload: json!({
                "nested": {
                    "deeply": {
                        "value": "found"
                    }
                }
            }),
        };

        let json = serde_json::to_string(&original).unwrap();
        let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, original.name);
        assert_eq!(
            parsed.payload["nested"]["deeply"]["value"],
            original.payload["nested"]["deeply"]["value"]
        );
    }

    // =========================================================================
    // SparseStateUpdate Tests
    // =========================================================================

    #[test]
    fn test_sparse_state_update() {
        let update = SparseStateUpdate {
            paths: vec!["user.name".to_string(), "count".to_string()],
            values: json!({
                "user.name": "Bob",
                "count": 42
            }),
            animation: None,
        };

        let json = serde_json::to_string(&update).unwrap();
        let parsed: SparseStateUpdate = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.paths.len(), 2);
        assert!(parsed.paths.contains(&"user.name".to_string()));
        assert_eq!(parsed.values["count"], 42);
    }

    #[test]
    fn test_sparse_state_update_empty() {
        let update = SparseStateUpdate {
            paths: vec![],
            values: json!({}),
            animation: None,
        };

        let json = serde_json::to_string(&update).unwrap();
        assert!(json.contains("\"paths\":[]"));
    }

    #[test]
    fn test_sparse_state_update_deeply_nested_paths() {
        let update = SparseStateUpdate {
            paths: vec!["a.b.c.d".to_string(), "x.y.z".to_string()],
            values: json!({
                "a.b.c.d": "deep value",
                "x.y.z": 123
            }),
            animation: None,
        };

        let json = serde_json::to_string(&update).unwrap();
        let parsed: SparseStateUpdate = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.paths.len(), 2);
        assert_eq!(parsed.values["a.b.c.d"], "deep value");
        assert_eq!(parsed.values["x.y.z"], 123);
    }

    #[test]
    fn test_sparse_state_update_complex_values() {
        let update = SparseStateUpdate {
            paths: vec!["user".to_string(), "items".to_string()],
            values: json!({
                "user": {"id": 1, "name": "Alice"},
                "items": [{"id": 1}, {"id": 2}]
            }),
            animation: None,
        };

        let json = serde_json::to_string(&update).unwrap();
        let parsed: SparseStateUpdate = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.values["user"]["id"], 1);
        assert_eq!(parsed.values["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_sparse_state_update_animation_field() {
        // Pre-animation envelopes (no "animation" key) still parse — and a
        // None round-trips to the same wire bytes (skip_serializing_if).
        let legacy = r#"{"paths":["count"],"values":{"count":1}}"#;
        let parsed: SparseStateUpdate = serde_json::from_str(legacy).unwrap();
        assert!(parsed.animation.is_none());
        assert_eq!(serde_json::to_string(&parsed).unwrap(), legacy);

        // Stamped envelopes carry the context through — both spec-object and
        // bare-curve-string forms (normalization happens engine-side).
        let stamped = r#"{"paths":["count"],"values":{"count":1},"animation":{"curve":"spring"}}"#;
        let parsed: SparseStateUpdate = serde_json::from_str(stamped).unwrap();
        assert_eq!(parsed.animation, Some(json!({"curve": "spring"})));

        let bare = r#"{"paths":["count"],"values":{"count":1},"animation":"spring"}"#;
        let parsed: SparseStateUpdate = serde_json::from_str(bare).unwrap();
        assert_eq!(parsed.animation, Some(json!("spring")));
    }

    // =========================================================================
    // WASI FFI Pattern Tests
    // These tests verify that our types work correctly in FFI scenarios
    // =========================================================================

    #[test]
    fn test_json_bytes_roundtrip() {
        // Simulates WASI FFI pattern: struct -> JSON bytes -> struct
        let config = ModuleConfig {
            name: "TestModule".to_string(),
            actions: vec!["act1".to_string()],
            state_keys: vec!["key1".to_string()],
            initial_state: json!({"key1": "value"}),
        };

        // Convert to bytes (what we'd pass across FFI)
        let json_bytes = serde_json::to_vec(&config).unwrap();

        // Parse from bytes (what we'd receive on the other side)
        let parsed: ModuleConfig = serde_json::from_slice(&json_bytes).unwrap();

        assert_eq!(parsed.name, config.name);
        assert_eq!(parsed.actions, config.actions);
    }

    #[test]
    fn test_action_dispatch_pattern() {
        // Simulates receiving an action from the UI and serializing for host
        let action = ActionPayload {
            name: "submitForm".to_string(),
            payload: json!({
                "formData": {
                    "username": "alice",
                    "remember": true
                }
            }),
        };

        // Serialize to JSON (what we'd return to host)
        let json = serde_json::to_string(&action).unwrap();

        // Host would parse this JSON
        let parsed: ActionPayload = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "submitForm");
        assert_eq!(parsed.payload["formData"]["username"], "alice");
    }

    #[test]
    fn test_state_update_pattern() {
        // Simulates sparse state update from host
        let update_json = r#"{
            "paths": ["counter", "user.lastActive"],
            "values": {
                "counter": 10,
                "user.lastActive": "2024-01-01T00:00:00Z"
            }
        }"#;

        let update: SparseStateUpdate = serde_json::from_str(update_json).unwrap();

        // Extract paths that changed
        assert!(update.paths.contains(&"counter".to_string()));
        assert!(update.paths.contains(&"user.lastActive".to_string()));

        // Get values
        assert_eq!(update.values["counter"], 10);
    }

    #[test]
    fn test_error_result_pattern() {
        // Simulates returning an error from engine to host
        let result: FfiResult<String> = FfiResult::Error {
            message: "Parse error at line 5: unexpected token".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();

        // Host checks status
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(parsed["message"].as_str().unwrap().contains("line 5"));
    }

    #[test]
    fn test_patches_array_pattern() {
        // Simulates returning patches as JSON array
        use crate::reconcile::Patch;

        let patches = vec![
            Patch::Create {
                id: "node1".to_string(),
                element_type: "Text".to_string(),
                props: std::sync::Arc::new(indexmap::IndexMap::new()),
                semantics: None,
            },
            Patch::SetText {
                id: "node1".to_string(),
                text: "Hello World".to_string(),
            },
        ];

        let json = serde_json::to_string(&patches).unwrap();
        let parsed: Vec<Patch> = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.len(), 2);
        match &parsed[0] {
            Patch::Create { element_type, .. } => assert_eq!(element_type, "Text"),
            _ => panic!("Expected Create patch"),
        }
    }

    #[test]
    fn test_patch_serializes_camelcase_field_names() {
        // Ensure patches serialize with camelCase field names for JavaScript consumption.
        // The #[serde(rename_all = "camelCase")] must be on EACH variant, not just the enum.
        use crate::reconcile::Patch;

        let create = Patch::Create {
            id: "n1".to_string(),
            element_type: "Column".to_string(),
            props: std::sync::Arc::new(indexmap::IndexMap::new()),
            semantics: None,
        };
        let json = serde_json::to_string(&create).unwrap();
        assert!(
            json.contains("\"elementType\""),
            "Create patch must use camelCase 'elementType', got: {}",
            json
        );
        assert!(
            !json.contains("\"element_type\""),
            "Create patch must NOT use snake_case 'element_type', got: {}",
            json
        );

        let insert = Patch::Insert {
            parent_id: "root".to_string(),
            id: "n1".to_string(),
            before_id: None,
        };
        let json = serde_json::to_string(&insert).unwrap();
        assert!(
            json.contains("\"parentId\""),
            "Insert patch must use camelCase 'parentId', got: {}",
            json
        );
        assert!(
            json.contains("\"beforeId\""),
            "Insert patch must use camelCase 'beforeId', got: {}",
            json
        );
        assert!(
            !json.contains("\"parent_id\""),
            "Insert patch must NOT use snake_case, got: {}",
            json
        );

        let mv = Patch::Move {
            parent_id: "root".to_string(),
            id: "n1".to_string(),
            before_id: Some("n2".to_string()),
        };
        let json = serde_json::to_string(&mv).unwrap();
        assert!(
            json.contains("\"parentId\""),
            "Move patch must use camelCase 'parentId', got: {}",
            json
        );
        assert!(
            json.contains("\"beforeId\""),
            "Move patch must use camelCase 'beforeId', got: {}",
            json
        );
    }
}
