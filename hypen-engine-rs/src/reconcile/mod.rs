//! Tree reconciliation and patch generation.
//!
//! This module owns the virtual instance tree and the diffing algorithm that
//! produces minimal [`Patch`] operations when the IR changes.
//!
//! ## Stable API
//!
//! - [`Patch`] — The patch enum consumed by platform renderers.
//!
//! ## Internal API (not stable)
//!
//! Everything else in this module (`InstanceTree`, `InstanceNode`, diffing
//! functions, binding resolution) is exported for integration testing but
//! may change between minor versions.

pub mod conditionals;
pub mod diff;
pub mod item_bindings;
pub mod keyed;
pub mod patch;
pub mod resolve;
pub mod tree;

pub(crate) use diff::{reconcile_ir_node_impl, ReconcileCtx};
// Only consumed by `wasm::shared`; re-export it under the same gate so
// native non-test builds don't flag it dead.
#[cfg(any(
    test,
    all(target_arch = "wasm32", any(feature = "js", feature = "wasi"))
))]
pub(crate) use diff::create_ir_node_tree_impl;
#[doc(hidden)]
pub use diff::{reconcile_ir, reconcile_ir_with_ds};
#[doc(hidden)]
pub use item_bindings::replace_item_bindings;
#[doc(hidden)]
pub use patch::node_id_str;
pub use patch::Patch;
#[doc(hidden)]
pub use resolve::{
    evaluate_binding, evaluate_binding_path, evaluate_item_binding, resolve_props,
    resolve_props_with_item,
};
#[doc(hidden)]
pub use tree::{ControlFlowKind, InstanceNode, InstanceTree};
