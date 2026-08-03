//! # Hypen Engine
//!
//! Core reactive rendering engine for the Hypen UI framework.
//!
//! This crate provides the platform-agnostic runtime that powers Hypen's
//! declarative UI model. It parses Hypen DSL, maintains a virtual tree,
//! tracks reactive dependencies, and emits minimal [`Patch`] operations
//! when state changes.
//!
//! ## Public API
//!
//! The primary types for SDK authors and application developers:
//!
//! - [`Engine`] — Native Rust engine (for embedding in Rust applications)
//! - [`EngineError`] — Structured error type for all engine operations
//! - [`Patch`] — UI mutation operations emitted by the engine
//! - [`Element`] / [`Value`] — IR building blocks for custom components
//! - [`Module`] / [`ModuleInstance`] — Stateful module management
//! - [`StateChange`] — Path-based state change notifications
//!
//! For WASM/JavaScript usage, see the [`wasm`] module (enabled via the `js` feature).
//!
//! ## Internal Modules
//!
//! The following modules are exported for advanced use and testing but are
//! **not part of the stable API**. Their signatures may change between
//! minor versions:
//!
//! `ir`, `reactive`, `reconcile`, `dispatch`, `render`, `serialize`

pub mod dispatch;
pub mod engine;
pub(crate) mod engine_core;
pub mod error;
pub mod ir;
pub mod lifecycle;
pub mod portable;
pub mod reactive;
pub mod reconcile;
pub mod serialize;
pub mod state;

/// Internal rendering logic shared between Engine and WasmEngine.
///
/// This module is public for integration testing but is not part of the
/// stable API — use [`Engine`] or `WasmEngine` instead.
#[doc(hidden)]
pub mod render;

/// Internal logging utilities.
#[doc(hidden)]
pub mod logger;

// WASM bindings module
// The FFI types (wasm::ffi) are always available for testing and cross-platform use.
// The actual WASM bindings are conditionally compiled:
// - `js` feature: JavaScript bindings via wasm-bindgen (Node.js, Bun, browsers)
// - `wasi` feature: WASI-compatible C FFI (Go, Python, Rust, etc.)
pub mod wasm;

// UniFFI bindings for native platforms (Kotlin, Swift, Python, Ruby)
#[cfg(feature = "uniffi")]
pub mod uniffi;

// UniFFI scaffolding must be in crate root
#[cfg(feature = "uniffi")]
::uniffi::setup_scaffolding!();

// ── Public API ─────────────────────────────────────────────────────────

pub use engine::Engine;
pub use error::EngineError;

pub use ir::{ast_to_ir_node, Element, IRNode, Value};
pub use ir::{
    check_accessibility, check_accessibility_source, check_accessibility_source_located,
    check_accessibility_trees, A11yDiagnostic, A11yRule, LineIndex, LocatedDiagnostic, SourceSpan,
};
pub use ir::{parse_svg, resolve_icons_in_ir, IconData, IconPath, ResourceRegistry};
pub use lifecycle::{Module, ModuleInstance};
pub use portable::{
    build_url, decode_uri_component, diff_paths, encode_uri_component, match_path, parse_query,
    path_delete, path_get, path_has, path_set, session_step, DiffEntry, RouteMatch, SessionEffect,
    SessionEvent, SessionPolicy, SessionState,
};
pub use reconcile::Patch;
pub use state::StateChange;

#[cfg(test)]
mod tailwind_tests {
    use hypen_tailwind_parse::parse_classes;

    #[test]
    fn test_tailwind_parse_basic() {
        let output = parse_classes("p-4 text-blue-500 bg-white");
        assert_eq!(output.base.len(), 3);

        let props = output.to_props();
        assert_eq!(props.get("padding"), Some(&"1rem".to_string()));
        assert_eq!(props.get("color"), Some(&"#3b82f6".to_string()));
        assert_eq!(props.get("background-color"), Some(&"#ffffff".to_string()));
    }

    #[test]
    fn test_tailwind_parse_with_breakpoints() {
        let output = parse_classes("p-4 md:p-8 lg:p-12");

        let props = output.to_props();
        assert_eq!(props.get("padding"), Some(&"1rem".to_string()));
        assert_eq!(props.get("padding@md"), Some(&"2rem".to_string()));
        assert_eq!(props.get("padding@lg"), Some(&"3rem".to_string()));
    }

    #[test]
    fn test_tailwind_parse_with_hover() {
        let output = parse_classes("bg-white hover:bg-blue-500");

        let props = output.to_props();
        assert_eq!(props.get("background-color"), Some(&"#ffffff".to_string()));
        assert_eq!(
            props.get("background-color:hover"),
            Some(&"#3b82f6".to_string())
        );
    }

    #[test]
    fn test_tailwind_parse_layout() {
        let output = parse_classes("flex justify-center items-center gap-4");

        let props = output.to_props();
        assert_eq!(props.get("display"), Some(&"flex".to_string()));
        assert_eq!(props.get("justify-content"), Some(&"center".to_string()));
        assert_eq!(props.get("align-items"), Some(&"center".to_string()));
        assert_eq!(props.get("gap"), Some(&"1rem".to_string()));
    }

    #[test]
    fn test_tailwind_parse_sizing() {
        let output = parse_classes("w-full h-screen max-w-lg");

        let props = output.to_props();
        assert_eq!(props.get("width"), Some(&"100%".to_string()));
        assert_eq!(props.get("height"), Some(&"100vh".to_string()));
        assert_eq!(props.get("max-width"), Some(&"32rem".to_string()));
    }
}
