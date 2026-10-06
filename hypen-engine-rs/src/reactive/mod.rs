//! Reactive dependency tracking and expression evaluation.
//!
//! This module tracks which nodes depend on which state paths, so that
//! state changes only re-render affected subtrees.
//!
//! Most types here are internal — SDK authors interact with reactivity
//! indirectly through [`Engine`](crate::Engine) and `WasmEngine`.

pub mod binding;
pub mod expression;
pub mod graph;
pub mod scheduler;

pub use binding::{parse_binding, Binding, BindingSource};
pub use expression::{
    build_evaluator, build_expression_context, evaluate_context_free_template, evaluate_expression,
    evaluate_template_string, extract_bindings_from_expression,
};
#[doc(hidden)]
pub use graph::DependencyGraph;
#[doc(hidden)]
pub use scheduler::Scheduler;
