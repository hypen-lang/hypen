//! Module and component lifecycle management.
//!
//! This module provides:
//!
//! - [`Module`] / [`ModuleInstance`] — Stateful modules with lifecycle hooks
//!   (created, destroyed) and reactive state management.
//! - [`ModuleLifecycle`] — Trait for receiving lifecycle notifications.
//! - [`ComponentLifecycle`] — Mount/unmount tracking for component instances.
//! - [`ResourceCache`] — Platform-agnostic cache for images, fonts, etc.

pub mod component;
pub mod module;
pub mod resource;

pub use component::ComponentLifecycle;
pub use module::{Module, ModuleInstance, ModuleLifecycle};
pub use resource::ResourceCache;
