//! Type-erasing adapter over [`hypen_server::ModuleInstance<S>`].
//!
//! `ModuleInstance` is generic over the user's state type `S`, but the
//! renderer doesn't care about that type — it only needs to:
//!
//! 1. Mount the module (which fires the initial render),
//! 2. Subscribe to the patch stream,
//! 3. Dispatch actions back when the user clicks something.
//!
//! `HypenModule` exposes exactly that contract via a trait object so
//! `DesktopApp` can hold any module without being generic itself.

use hypen_engine::Patch;
use hypen_server::prelude::{ModuleInstance, State};
use serde_json::Value;
use std::sync::Arc;

/// Erased module API used by `DesktopApp`.
pub trait HypenModule: Send + Sync + 'static {
    /// Wire a callback that receives every patch batch the module emits,
    /// including the initial render fired by `mount()`.
    fn on_patches(&self, cb: Arc<dyn Fn(&[Patch]) + Send + Sync>);

    /// Trigger the initial render and run the sync `on_created` handler.
    fn mount(&self);

    /// Forward a click / keystroke / hover to the module's action dispatcher.
    /// Errors (unknown action, async-only handler) are logged but not
    /// propagated — the renderer keeps running.
    fn dispatch_action(&self, name: &str, payload: Option<Value>);
}

impl<S: State> HypenModule for ModuleInstance<S> {
    fn on_patches(&self, cb: Arc<dyn Fn(&[Patch]) + Send + Sync>) {
        ModuleInstance::on_patches(self, move |patches| cb(patches));
    }

    fn mount(&self) {
        ModuleInstance::mount(self);
    }

    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        if let Err(err) = ModuleInstance::dispatch_action(self, name, payload) {
            log::warn!("dispatch_action({name}) failed: {err}");
        }
    }
}
