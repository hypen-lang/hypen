//! WASM/WASI interface for Hypen Engine
//!
//! This module provides bindings for running the engine in WASM environments.
//! Two interface types are available:
//!
//! ## JavaScript Runtimes (`js` feature)
//!
//! For Node.js, Bun, Deno, and browsers. Uses wasm-bindgen for seamless JavaScript
//! interop with native JS types and callbacks.
//!
//! ```toml
//! [dependencies]
//! hypen-engine = { features = ["js"] }
//! ```
//!
//! ## WASI Runtimes (`wasi` feature)
//!
//! For Go (wazero, wasmtime-go), Python (wasmtime, wasmer), Rust, and other
//! languages that embed WASM via WASI. Uses a C-compatible FFI with JSON
//! serialization for data exchange.
//!
//! ```toml
//! [dependencies]
//! hypen-engine = { features = ["wasi"] }
//! ```
//!
//! ## Feature Flags
//!
//! - `js` - Enable JavaScript bindings via wasm-bindgen (default for wasm-pack builds)
//! - `wasi` - Enable WASI-compatible C FFI bindings
//!
//! These features are mutually exclusive. If both are enabled, `js` takes precedence.

// Shared FFI utilities (available on all platforms for testing)
pub mod ffi;

// Binding-agnostic helpers used by both the JS and WASI glue.
// Compiled for wasm32 builds (where js.rs / wasi.rs consume them) and
// for `cargo test` (so the helpers can be unit-tested natively — the
// code itself contains nothing wasm-specific).
#[cfg(any(
    test,
    all(target_arch = "wasm32", any(feature = "js", feature = "wasi"))
))]
pub(crate) mod shared;

// JavaScript bindings (wasm-bindgen)
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub mod js;

// Re-export JS types at module root for backward compatibility
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub use js::*;

// WASI bindings (C FFI)
#[cfg(all(target_arch = "wasm32", feature = "wasi", not(feature = "js")))]
pub mod wasi;

// Re-export WASI functions at module root
#[cfg(all(target_arch = "wasm32", feature = "wasi", not(feature = "js")))]
pub use wasi::*;

// If neither feature is enabled but we're on wasm32, provide a helpful error
#[cfg(all(target_arch = "wasm32", not(feature = "js"), not(feature = "wasi")))]
compile_error!(
    "Either 'js' or 'wasi' feature must be enabled for WASM builds. \
     Use --features js for JavaScript runtimes or --features wasi for WASI runtimes."
);
