//! Host-portable pure helpers.
//!
//! The single canonical implementation of the algorithms each host SDK
//! needs to call into: JSON-tree diffing, URL pattern matching, and
//! session state-machine decisions.
//!
//! Every helper is pure (no I/O, no clocks, no native handles; JSON or
//! strings in, JSON or strings out) and is exported on all four binding
//! surfaces — native Rust, wasm-bindgen (`js` feature), WASI C FFI
//! (`wasi` feature), and UniFFI (`uniffi` feature). The cross-SDK
//! fixtures in `engine-compatibility-tests/fixtures/portable/` assert
//! byte-equal output across every host.
//!
//! One exception to purity: [`patch_expand::TemplateExpander`] holds the
//! skeletons registered over a session (a `RegisterTemplate` crosses the
//! wire once), so it is a stateful struct rather than a free function.
//! Its expansion itself is still deterministic — same registered
//! skeletons, same batch in, same batch out.

pub mod diff;
pub mod patch_expand;
pub mod path;
pub mod route;
pub mod session;
pub mod url;
pub mod variant;

pub use diff::{diff_paths, DiffEntry};
pub use patch_expand::TemplateExpander;
pub use path::{path_delete, path_get, path_has, path_set};
pub use route::{match_path, RouteMatch};
pub use session::{session_step, SessionEffect, SessionEvent, SessionPolicy, SessionState};
pub use url::{build_url, decode_uri_component, encode_uri_component, parse_query};
pub use variant::{
    breakpoint_min_width, is_breakpoint, is_state, is_variant_token, parse_prop_key,
    pick_variant_base, ParsedKey,
};
