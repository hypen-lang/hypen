//! Tests for src/logger.rs - Logging system
//!
//! Tests log configuration, level filtering, and scope filtering

use hypen_engine::logger::{LogConfig, LogLevel, LogScope};

// ============================================================================
// LogConfig Builder Methods (5 tests)
// ============================================================================

#[test]
fn test_log_config_default() {
    // GIVEN/WHEN: Create default LogConfig
    let config = LogConfig::default();

    // THEN: Default values set
    assert_eq!(config.min_level, LogLevel::Info);
    assert_eq!(config.enabled_scopes.len(), 0); // Empty = all enabled
    assert!(!config.timestamps);
}

#[test]
fn test_log_config_with_level() {
    // GIVEN: Default config
    let config = LogConfig::default();

    // WHEN: Set minimum level to Debug
    let config = config.with_level(LogLevel::Debug);

    // THEN: Level updated
    assert_eq!(config.min_level, LogLevel::Debug);
}

#[test]
fn test_log_config_enable_all() {
    // GIVEN: Default config
    let config = LogConfig::default();

    // WHEN: Enable all levels
    let config = config.enable_all();

    // THEN: Minimum level set to Trace
    assert_eq!(config.min_level, LogLevel::Trace);
}

#[test]
fn test_log_config_with_scopes() {
    // GIVEN: Default config
    let config = LogConfig::default();

    // WHEN: Enable specific scopes
    let config = config.with_scopes(vec![LogScope::Engine, LogScope::Reconciler]);

    // THEN: Scopes set
    assert_eq!(config.enabled_scopes.len(), 2);
    assert!(config.enabled_scopes.contains(&LogScope::Engine));
    assert!(config.enabled_scopes.contains(&LogScope::Reconciler));
}

#[test]
fn test_log_config_with_timestamps() {
    // GIVEN: Default config
    let config = LogConfig::default();
    assert!(!config.timestamps);

    // WHEN: Enable timestamps
    let config = config.with_timestamps();

    // THEN: Timestamps enabled
    assert!(config.timestamps);
}

// ============================================================================
// Scope/Level Filtering (5 tests)
// ============================================================================

#[test]
fn test_should_log_filters_by_level() {
    // GIVEN: Config with minimum level Info
    let config = LogConfig::default().with_level(LogLevel::Info);

    // WHEN: Check different levels
    // THEN: Filters correctly
    assert!(!config.should_log(LogScope::Engine, LogLevel::Trace)); // Below min
    assert!(!config.should_log(LogScope::Engine, LogLevel::Debug)); // Below min
    assert!(config.should_log(LogScope::Engine, LogLevel::Info)); // Exactly min
    assert!(config.should_log(LogScope::Engine, LogLevel::Warn)); // Above min
    assert!(config.should_log(LogScope::Engine, LogLevel::Error)); // Above min
}

#[test]
fn test_should_log_allows_all_scopes_when_empty() {
    // GIVEN: Config with empty scopes list
    let config = LogConfig::default().with_level(LogLevel::Debug);

    // WHEN: Check different scopes
    // THEN: All scopes allowed
    assert!(config.should_log(LogScope::Parser, LogLevel::Info));
    assert!(config.should_log(LogScope::Engine, LogLevel::Info));
    assert!(config.should_log(LogScope::Reconciler, LogLevel::Info));
    assert!(config.should_log(LogScope::State, LogLevel::Info));
}

#[test]
fn test_should_log_filters_by_scope() {
    // GIVEN: Config with specific scopes enabled
    let config = LogConfig::default()
        .with_level(LogLevel::Info)
        .with_scopes(vec![LogScope::Engine, LogScope::State]);

    // WHEN: Check different scopes
    // THEN: Only enabled scopes allowed
    assert!(config.should_log(LogScope::Engine, LogLevel::Info)); // Enabled
    assert!(config.should_log(LogScope::State, LogLevel::Info)); // Enabled
    assert!(!config.should_log(LogScope::Parser, LogLevel::Info)); // Not enabled
    assert!(!config.should_log(LogScope::Reconciler, LogLevel::Info)); // Not enabled
}

#[test]
fn test_should_log_combines_level_and_scope_filters() {
    // GIVEN: Config with level and scopes
    let config = LogConfig::default()
        .with_level(LogLevel::Warn)
        .with_scopes(vec![LogScope::Engine]);

    // WHEN: Check combinations
    // THEN: Both filters applied
    assert!(!config.should_log(LogScope::Engine, LogLevel::Info)); // Wrong level
    assert!(config.should_log(LogScope::Engine, LogLevel::Warn)); // Both match
    assert!(config.should_log(LogScope::Engine, LogLevel::Error)); // Both match
    assert!(!config.should_log(LogScope::Parser, LogLevel::Warn)); // Wrong scope
    assert!(!config.should_log(LogScope::Parser, LogLevel::Info)); // Both wrong
}

#[test]
fn test_should_log_enable_all_allows_trace() {
    // GIVEN: Config with enable_all
    let config = LogConfig::default().enable_all();

    // WHEN: Check trace level
    // THEN: Allowed
    assert!(config.should_log(LogScope::Engine, LogLevel::Trace));
    assert!(config.should_log(LogScope::Parser, LogLevel::Trace));
}

// ============================================================================
// Log Level Ordering and Display (3 tests)
// ============================================================================

#[test]
fn test_log_level_ordering() {
    // GIVEN: Different log levels
    // THEN: Correct ordering
    assert!(LogLevel::Trace < LogLevel::Debug);
    assert!(LogLevel::Debug < LogLevel::Info);
    assert!(LogLevel::Info < LogLevel::Warn);
    assert!(LogLevel::Warn < LogLevel::Error);
}

#[test]
fn test_log_level_display() {
    // GIVEN: Log levels
    // WHEN: Convert to string
    // THEN: Correct display format
    assert_eq!(format!("{}", LogLevel::Trace), "trace");
    assert_eq!(format!("{}", LogLevel::Debug), "debug");
    assert_eq!(format!("{}", LogLevel::Info), "info");
    assert_eq!(format!("{}", LogLevel::Warn), "warn");
    assert_eq!(format!("{}", LogLevel::Error), "error");
}

#[test]
fn test_log_scope_display() {
    // GIVEN: Log scopes
    // WHEN: Convert to string
    // THEN: Correct display format
    assert_eq!(format!("{}", LogScope::Parser), "parser");
    assert_eq!(format!("{}", LogScope::Engine), "engine");
    assert_eq!(format!("{}", LogScope::Reconciler), "reconciler");
    assert_eq!(format!("{}", LogScope::Renderer), "renderer");
    assert_eq!(format!("{}", LogScope::Router), "router");
    assert_eq!(format!("{}", LogScope::Lifecycle), "lifecycle");
    assert_eq!(format!("{}", LogScope::State), "state");
    assert_eq!(format!("{}", LogScope::Component), "component");
    assert_eq!(format!("{}", LogScope::Wasm), "wasm");
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_log_config_builder_chaining() {
    // GIVEN: Default config
    // WHEN: Chain multiple builder methods
    let config = LogConfig::default()
        .with_level(LogLevel::Debug)
        .with_scopes(vec![LogScope::Engine])
        .with_timestamps();

    // THEN: All settings applied
    assert_eq!(config.min_level, LogLevel::Debug);
    assert_eq!(config.enabled_scopes.len(), 1);
    assert!(config.timestamps);
}

#[test]
fn test_log_level_equality() {
    // GIVEN: Log levels
    let level1 = LogLevel::Info;
    let level2 = LogLevel::Info;
    let level3 = LogLevel::Warn;

    // THEN: Equality works correctly
    assert_eq!(level1, level2);
    assert_ne!(level1, level3);
}

#[test]
fn test_log_scope_equality() {
    // GIVEN: Log scopes
    let scope1 = LogScope::Engine;
    let scope2 = LogScope::Engine;
    let scope3 = LogScope::Parser;

    // THEN: Equality works correctly
    assert_eq!(scope1, scope2);
    assert_ne!(scope1, scope3);
}

#[test]
fn test_log_config_serialization() {
    // GIVEN: LogConfig
    let config = LogConfig::default()
        .with_level(LogLevel::Warn)
        .with_scopes(vec![LogScope::Engine, LogScope::State]);

    // WHEN: Serialize to JSON
    let json = serde_json::to_value(&config).unwrap();

    // THEN: All fields serialized
    assert_eq!(json["min_level"], "warn");
    assert!(json["enabled_scopes"].is_array());
    assert_eq!(json["timestamps"], false);
}

#[test]
fn test_log_config_deserialization() {
    // GIVEN: JSON representation
    let json = serde_json::json!({
        "min_level": "error",
        "enabled_scopes": ["parser", "engine"],
        "timestamps": true
    });

    // WHEN: Deserialize from JSON
    let config: LogConfig = serde_json::from_value(json).unwrap();

    // THEN: All fields deserialized correctly
    assert_eq!(config.min_level, LogLevel::Error);
    assert_eq!(config.enabled_scopes.len(), 2);
    assert!(config.enabled_scopes.contains(&LogScope::Parser));
    assert!(config.enabled_scopes.contains(&LogScope::Engine));
    assert!(config.timestamps);
}

#[test]
fn test_log_level_clone_copy() {
    // GIVEN: LogLevel
    let level = LogLevel::Info;

    // WHEN: Copy it
    let copied = level;

    // THEN: Both usable
    assert_eq!(level, copied);
    assert_eq!(level, LogLevel::Info);
}

#[test]
fn test_log_scope_clone_copy() {
    // GIVEN: LogScope
    let scope = LogScope::Engine;

    // WHEN: Copy it
    let copied = scope;

    // THEN: Both usable
    assert_eq!(scope, copied);
    assert_eq!(scope, LogScope::Engine);
}
