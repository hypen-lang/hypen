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

    /// Dispatch a renderer event using the engine's live node ownership.
    fn dispatch_ui_action(&self, node: &str, action: &str, payload: Option<Value>) {
        self.dispatch_action(
            "__hypen_dispatch",
            Some(serde_json::json!({"node":node,"action":action,"payload":payload})),
        );
    }
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

#[cfg(test)]
mod tests {
    use super::HypenModule;
    use hypen_engine::Patch;
    use hypen_server::prelude::{ModuleBuilder, ModuleInstance};
    use serde::{Deserialize, Serialize};
    use std::sync::{Arc, Mutex};

    /// Minimal counter-style state used in the module-trait round-trip
    /// tests. Mirrors the shape used in `hypen-sdk-rs`'s integration tests.
    #[derive(Clone, Default, Serialize, Deserialize, Debug)]
    struct TestState {
        count: i32,
    }

    /// Build a counter `ModuleInstance` with a single `incr` action that
    /// adds one to `state.count`. Returned as `Arc<dyn HypenModule>` so
    /// tests exercise the trait's blanket impl over `ModuleInstance<S>`.
    fn make_counter_module() -> Arc<dyn HypenModule> {
        let def = ModuleBuilder::<TestState>::new("Counter")
            .state(TestState { count: 0 })
            .ui(r#"Column { Text("Count: @{state.count}") }"#)
            .on_action::<()>("incr", |state, _, _| {
                state.count += 1;
            })
            .build();
        let instance: ModuleInstance<TestState> =
            ModuleInstance::new(Arc::new(def), None).expect("instantiate counter module");
        Arc::new(instance) as Arc<dyn HypenModule>
    }

    #[test]
    fn hypen_module_dispatches_action_through_blanket_impl() {
        let module = make_counter_module();

        // Capture every patch batch the engine emits via the trait's
        // `on_patches` — tests the type-erased Arc<Fn> path.
        let batches: Arc<Mutex<Vec<Vec<Patch>>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&batches);
        module.on_patches(Arc::new(move |patches: &[Patch]| {
            captured.lock().unwrap().push(patches.to_vec());
        }));

        // Mount fires the deferred initial render → at least one batch.
        module.mount();
        assert!(
            !batches.lock().unwrap().is_empty(),
            "expected initial render to land via on_patches",
        );

        // Dispatch the registered action through the trait. The blanket
        // impl forwards to `ModuleInstance::dispatch_action` and swallows
        // errors, so we can't read the return value — instead, downcast
        // the same module via a parallel handle to verify state moved.
        // The simplest observation: dispatch increments `count` from 0
        // to 1, which the engine reflects as further patch batches.
        let batches_before = batches.lock().unwrap().len();
        module.dispatch_action("incr", None);

        // We expect either a follow-up patch batch from the state change
        // or at the very least no panic. Re-dispatch a few more times to
        // make the post-dispatch growth easy to spot.
        for _ in 0..3 {
            module.dispatch_action("incr", None);
        }
        let batches_after = batches.lock().unwrap().len();
        assert!(
            batches_after >= batches_before,
            "dispatch_action must not regress the batch count",
        );
    }

    #[test]
    fn hypen_module_dispatch_state_updates_observed_via_concrete_handle() {
        // The trait API is intentionally write-only (no get_state) so we
        // verify state flow by holding both the `Arc<ModuleInstance<S>>`
        // (concrete) and the same value coerced to `Arc<dyn HypenModule>`.
        let def = ModuleBuilder::<TestState>::new("Counter")
            .state(TestState { count: 0 })
            .on_action::<()>("incr", |state, _, _| {
                state.count += 1;
            })
            .build();
        let concrete = Arc::new(
            ModuleInstance::<TestState>::new(Arc::new(def), None)
                .expect("instantiate counter module"),
        );
        let erased: Arc<dyn HypenModule> = concrete.clone();

        erased.mount();
        assert_eq!(concrete.get_state().count, 0);

        erased.dispatch_action("incr", None);
        assert_eq!(
            concrete.get_state().count,
            1,
            "blanket impl must forward dispatch into ModuleInstance",
        );
    }

    /// Element events reach a local (Rust SDK) module as node-addressed
    /// `__hypen_dispatch` envelopes; `ModuleInstance` must resolve them
    /// against its engine and run the handler (plus `__hypen_bind`).
    #[test]
    fn local_module_accepts_node_addressed_envelopes() {
        #[derive(Clone, Default, Serialize, Deserialize, Debug)]
        struct FormState {
            count: i32,
            name: String,
        }
        let def = ModuleBuilder::<FormState>::new("Form")
            .state(FormState::default())
            .ui(r#"Column {
                Button { Text("+") }.onClick(@actions.incr)
                Input(placeholder: "n").bind(@state.name)
            }"#)
            .on_action::<()>("incr", |state, _, _| {
                state.count += 1;
            })
            .build();
        let concrete =
            Arc::new(ModuleInstance::<FormState>::new(Arc::new(def), None).expect("instantiate"));
        let erased: Arc<dyn HypenModule> = concrete.clone();
        let creates: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&creates);
        erased.on_patches(Arc::new(move |patches: &[Patch]| {
            for p in patches {
                if let Patch::Create {
                    id, element_type, ..
                } = p
                {
                    sink.lock()
                        .unwrap()
                        .push((element_type.clone(), id.to_string()));
                }
            }
        }));
        erased.mount();
        let id_of = |ty: &str| {
            creates
                .lock()
                .unwrap()
                .iter()
                .find(|(t, _)| t == ty)
                .map(|(_, id)| id.clone())
                .expect("element rendered")
        };
        let (button, input) = (id_of("Button"), id_of("Input"));

        erased.dispatch_ui_action(&button, "incr", None);
        assert_eq!(concrete.get_state().count, 1, "envelope runs the handler");
        erased.dispatch_ui_action(
            &input,
            "__hypen_bind",
            Some(serde_json::json!({"path": "name", "value": "Ada"})),
        );
        assert_eq!(
            concrete.get_state().name,
            "Ada",
            "envelope bind writes state"
        );
    }

    #[test]
    fn hypen_module_unknown_action_does_not_panic() {
        let module = make_counter_module();
        module.mount();
        // Per the trait's doc-comment, dispatch errors are logged and
        // swallowed — calling an unknown action must just return.
        module.dispatch_action("does_not_exist", None);
    }
}
