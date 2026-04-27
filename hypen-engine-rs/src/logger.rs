//! Logging system for the Hypen engine
//!
//! Provides a unified logging interface that can be configured with different
//! log levels and scopes. For WASM builds, logs are routed through a host-provided
//! logger callback.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Log level for filtering messages
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
}

impl fmt::Display for LogLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogLevel::Trace => write!(f, "trace"),
            LogLevel::Debug => write!(f, "debug"),
            LogLevel::Info => write!(f, "info"),
            LogLevel::Warn => write!(f, "warn"),
            LogLevel::Error => write!(f, "error"),
        }
    }
}

/// Log scope for categorizing messages
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogScope {
    Parser,
    Engine,
    Reconciler,
    Renderer,
    Router,
    Lifecycle,
    State,
    Component,
    Wasm,
}

impl fmt::Display for LogScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogScope::Parser => write!(f, "parser"),
            LogScope::Engine => write!(f, "engine"),
            LogScope::Reconciler => write!(f, "reconciler"),
            LogScope::Renderer => write!(f, "renderer"),
            LogScope::Router => write!(f, "router"),
            LogScope::Lifecycle => write!(f, "lifecycle"),
            LogScope::State => write!(f, "state"),
            LogScope::Component => write!(f, "component"),
            LogScope::Wasm => write!(f, "wasm"),
        }
    }
}

/// Configuration for the logging system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    /// Minimum log level to display
    pub min_level: LogLevel,
    /// Scopes to enable (empty = all scopes enabled)
    pub enabled_scopes: Vec<LogScope>,
    /// Whether to include timestamps
    pub timestamps: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            min_level: LogLevel::Info,
            enabled_scopes: Vec::new(), // Empty means all enabled
            timestamps: false,
        }
    }
}

impl LogConfig {
    /// Check if a given scope and level should be logged
    pub fn should_log(&self, scope: LogScope, level: LogLevel) -> bool {
        // Check level
        if level < self.min_level {
            return false;
        }

        // Check scope (empty list means all enabled)
        if !self.enabled_scopes.is_empty() && !self.enabled_scopes.contains(&scope) {
            return false;
        }

        true
    }

    /// Enable all log levels (trace and above)
    pub fn enable_all(mut self) -> Self {
        self.min_level = LogLevel::Trace;
        self
    }

    /// Enable specific scopes only
    pub fn with_scopes(mut self, scopes: Vec<LogScope>) -> Self {
        self.enabled_scopes = scopes;
        self
    }

    /// Set minimum log level
    pub fn with_level(mut self, level: LogLevel) -> Self {
        self.min_level = level;
        self
    }

    /// Enable timestamps
    pub fn with_timestamps(mut self) -> Self {
        self.timestamps = true;
        self
    }
}

/// A log message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogMessage {
    pub level: LogLevel,
    pub scope: LogScope,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
}

/// Logger interface - can be implemented by host
pub trait Logger: Send + Sync {
    fn log(&self, level: LogLevel, scope: LogScope, message: &str);
}

// Global logger instance (for JS WASM builds)
// Uses thread_local because WASM is single-threaded and js_sys::Function is !Send
#[cfg(all(target_arch = "wasm32", feature = "js"))]
thread_local! {
    static LOGGER: std::cell::RefCell<Option<WasmLogger>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub struct WasmLogger {
    config: LogConfig,
    callback: Option<js_sys::Function>,
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
impl WasmLogger {
    pub fn new(config: LogConfig) -> Self {
        Self {
            config,
            callback: None,
        }
    }

    pub fn set_callback(&mut self, callback: js_sys::Function) {
        self.callback = Some(callback);
    }

    pub fn log(&self, level: LogLevel, scope: LogScope, message: &str) {
        if !self.config.should_log(scope, level) {
            return;
        }

        if let Some(ref callback) = self.callback {
            // Create log message
            let log_msg = LogMessage {
                level,
                scope,
                message: message.to_string(),
                timestamp: if self.config.timestamps {
                    Some(js_sys::Date::now())
                } else {
                    None
                },
            };

            // Serialize and call JavaScript callback
            if let Ok(js_value) = serde_wasm_bindgen::to_value(&log_msg) {
                let _ = callback.call1(&wasm_bindgen::JsValue::NULL, &js_value);
            }
        } else {
            // Fallback to console.log if no callback
            self.fallback_log(level, scope, message);
        }
    }

    fn fallback_log(&self, level: LogLevel, scope: LogScope, message: &str) {
        let formatted = format!("[{}] [{}] {}", level, scope, message);
        let js_string = wasm_bindgen::JsValue::from_str(&formatted);

        match level {
            LogLevel::Error => web_sys::console::error_1(&js_string),
            LogLevel::Warn => web_sys::console::warn_1(&js_string),
            LogLevel::Info => web_sys::console::info_1(&js_string),
            LogLevel::Debug => web_sys::console::debug_1(&js_string),
            LogLevel::Trace => web_sys::console::log_1(&js_string),
        }
    }
}

/// Initialize the global logger (JS WASM only)
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub fn init_logger(config: LogConfig) {
    let logger = WasmLogger::new(config);
    LOGGER.with(|l| {
        *l.borrow_mut() = Some(logger);
    });
}

/// Set the logger callback (JS WASM only)
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub fn set_logger_callback(callback: js_sys::Function) {
    LOGGER.with(|l| {
        if let Some(ref mut logger) = *l.borrow_mut() {
            logger.set_callback(callback);
        }
    });
}

/// Update logger configuration (JS WASM only)
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub fn update_logger_config(config: LogConfig) {
    LOGGER.with(|l| {
        if let Some(ref mut logger) = *l.borrow_mut() {
            logger.config = config;
        }
    });
}

/// Log a message (JS WASM only)
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub fn log(level: LogLevel, scope: LogScope, message: &str) {
    LOGGER.with(|l| {
        if let Some(ref logger) = *l.borrow() {
            logger.log(level, scope, message);
        }
    });
}

/// Log a message (native builds and WASI WASM)
#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
pub fn log(level: LogLevel, scope: LogScope, message: &str) {
    eprintln!("[{}] [{}] {}", level, scope, message);
}

/// Convenience macros for logging
#[macro_export]
macro_rules! log_trace {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::LogLevel::Trace, $scope, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::LogLevel::Debug, $scope, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_info {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::LogLevel::Info, $scope, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::LogLevel::Warn, $scope, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logger::log($crate::logger::LogLevel::Error, $scope, &format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_level_ordering() {
        assert!(LogLevel::Trace < LogLevel::Debug);
        assert!(LogLevel::Debug < LogLevel::Info);
        assert!(LogLevel::Info < LogLevel::Warn);
        assert!(LogLevel::Warn < LogLevel::Error);
    }

    #[test]
    fn test_log_config_should_log() {
        let config = LogConfig::default(); // Info level by default

        assert!(!config.should_log(LogScope::Engine, LogLevel::Trace));
        assert!(!config.should_log(LogScope::Engine, LogLevel::Debug));
        assert!(config.should_log(LogScope::Engine, LogLevel::Info));
        assert!(config.should_log(LogScope::Engine, LogLevel::Warn));
        assert!(config.should_log(LogScope::Engine, LogLevel::Error));
    }

    #[test]
    fn test_log_config_scopes() {
        let config = LogConfig::default().with_scopes(vec![LogScope::Engine, LogScope::Reconciler]);

        assert!(config.should_log(LogScope::Engine, LogLevel::Info));
        assert!(config.should_log(LogScope::Reconciler, LogLevel::Info));
        assert!(!config.should_log(LogScope::Renderer, LogLevel::Info));
    }
}
