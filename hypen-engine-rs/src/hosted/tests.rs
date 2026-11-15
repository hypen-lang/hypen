//! The subsystem driven directly — `HostedModules` + a bare `EngineCore` + a
//! scripted host, no `Engine`. These pin the bad paths and the structured
//! failure report; the end-to-end contract (rendering, routing through
//! `Engine`) is pinned by `tests/test_module_host_cascade.rs` and
//! `tests/test_module_host_routing.rs`.

use super::*;
use crate::engine::RenderCallback;
use crate::module_host::{HostError, ModuleManifest, ReducerOutput, SiblingState};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

const ACTIVATED: &str = "@activated";
const DEACTIVATED: &str = "@deactivated";
const DESTROYED: &str = "@destroyed";

/// What one call into the host saw.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    id: u64,
    action: String,
    payload: String,
    state: Value,
    /// The sibling snapshots the call was handed, by scope.
    siblings: Vec<(String, Value)>,
}

type Reducer = Box<dyn FnMut(&Seen) -> Result<ReducerOutput, HostError> + Send>;

#[derive(Default)]
struct Script {
    reducers: HashMap<u64, Reducer>,
    /// Instances that trapped: every later call fails with `DeadInstance`,
    /// like the wasmtime hosts.
    dead: HashSet<u64>,
    seen: Vec<Seen>,
}

/// A host whose instances are closures; lifecycle hooks reach the same
/// closure under the pseudo-action names above.
struct ScriptHost(Arc<Mutex<Script>>);

impl ScriptHost {
    fn call(
        &mut self,
        id: ModuleInstanceId,
        action: &str,
        payload: &[u8],
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let mut script = self.0.lock().unwrap();
        if script.dead.contains(&id.0) {
            return Err(HostError::DeadInstance);
        }
        let seen = Seen {
            id: id.0,
            action: action.to_string(),
            payload: String::from_utf8_lossy(payload).into_owned(),
            state: serde_json::from_slice(state).expect("the engine hands out JSON state"),
            siblings: siblings
                .iter()
                .map(|(scope, bytes)| {
                    let state = serde_json::from_slice(bytes).expect("sibling state is JSON");
                    (scope.clone(), state)
                })
                .collect(),
        };
        script.seen.push(seen.clone());
        let result = match script.reducers.get_mut(&id.0) {
            Some(reducer) => reducer(&seen),
            None => Ok(ReducerOutput::default()),
        };
        if matches!(result, Err(HostError::Trap(_))) {
            script.dead.insert(id.0);
        }
        result
    }
}

impl ModuleHost for ScriptHost {
    fn register(&mut self, _: &str, _: &[u8], _: ModuleManifest) -> Result<(), HostError> {
        Ok(())
    }
    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        Err(HostError::UnknownModule(name.to_string()))
    }
    fn destroy(&mut self, _: ModuleInstanceId) -> Result<(), HostError> {
        Ok(())
    }
    fn init(&mut self, _: ModuleInstanceId, _: &[u8]) -> Result<Vec<u8>, HostError> {
        Ok(b"{}".to_vec())
    }
    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.call(id, &action.name, &action.payload, state, siblings)
    }
    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.call(id, ACTIVATED, b"", state, siblings)
    }
    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        self.call(id, DEACTIVATED, b"", state, &[])
    }
    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        self.call(id, DESTROYED, b"", state, &[]).map(|_| ())
    }
    fn actions(&mut self, _: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        Ok(Vec::new())
    }
}

/// The subsystem and the engine parts it works on — no `Engine`.
struct Fixture {
    hosted: HostedModules,
    core: EngineCore,
    closures: ActionDispatcher,
    patches: Option<RenderCallback>,
    script: Arc<Mutex<Script>>,
    next_id: u64,
}

impl Fixture {
    fn new() -> Self {
        let script = Arc::new(Mutex::new(Script::default()));
        let mut hosted = HostedModules::new();
        hosted.set_host(Box::new(ScriptHost(Arc::clone(&script))));
        Self {
            hosted,
            core: EngineCore::new(),
            closures: ActionDispatcher::new(),
            patches: None,
            script,
            next_id: 0,
        }
    }

    fn parts(&mut self) -> (&mut HostedModules, EngineCtx<'_>) {
        let ctx = EngineCtx {
            core: &mut self.core,
            closures: &self.closures,
            patches: &mut self.patches,
        };
        (&mut self.hosted, ctx)
    }

    /// Wire a module whose reducer is `reducer`; returns its instance id.
    fn module(
        &mut self,
        scope: &str,
        actions: &[&str],
        grants: ModuleGrants,
        reducer: impl FnMut(&Seen) -> Result<ReducerOutput, HostError> + Send + 'static,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.script
            .lock()
            .unwrap()
            .reducers
            .insert(id, Box::new(reducer));
        let actions = actions.iter().map(|a| a.to_string()).collect();
        let (hosted, mut ctx) = self.parts();
        hosted
            .register(
                &mut ctx,
                scope,
                ModuleInstanceId(id),
                actions,
                grants,
                json!({}),
            )
            .unwrap();
        id
    }

    fn dispatch(&mut self, scope: &str, name: &str) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.parts();
        hosted.dispatch_trusted(&mut ctx, scope, name, Value::Null)
    }

    fn lifecycle(&mut self, scope: &str, hook: LifecycleHook) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.parts();
        hosted.run_lifecycle(&mut ctx, scope, hook)
    }

    fn destroy(&mut self, scope: &str) -> Result<(), EngineError> {
        let (hosted, mut ctx) = self.parts();
        hosted.destroy(&mut ctx, scope)
    }

    /// A host deep-merge write, as `Engine::update_state` performs it.
    fn host_write(&mut self, scope: &str, patch: Value) {
        let notice = self
            .hosted
            .host_write_notice(&self.core, Some(scope), |state, changed| {
                paths::collect_merge_changes(state, &patch, &mut String::new(), changed)
            });
        assert!(self.core.update_state(Some(scope), patch, None));
        if let Some(notice) = notice {
            let (hosted, mut ctx) = self.parts();
            hosted.notify_host_write(&mut ctx, notice);
        }
    }

    fn state(&self, scope: &str) -> Value {
        self.core.get_module_state(scope).cloned().unwrap()
    }

    /// `(instance, action)` of every host call so far, clearing the log.
    fn calls(&self) -> Vec<(u64, String)> {
        let seen = std::mem::take(&mut self.script.lock().unwrap().seen);
        seen.into_iter().map(|s| (s.id, s.action)).collect()
    }

    fn report(&self) -> &CascadeReport {
        self.hosted
            .last_report()
            .expect("the last cascade had failures")
    }
}

fn action(name: &str) -> HostAction {
    HostAction::new(name, b"null".to_vec())
}

fn emit(names: &[&str]) -> ReducerOutput {
    ReducerOutput {
        emit: names.iter().map(|n| action(n)).collect(),
        ..Default::default()
    }
}

fn cross(target: &str, name: &str) -> ReducerOutput {
    ReducerOutput {
        cross_dispatch: vec![(target.to_string(), action(name))],
        ..Default::default()
    }
}

fn with_state(state: Value) -> ReducerOutput {
    ReducerOutput {
        state: Some(serde_json::to_vec(&state).unwrap()),
        ..Default::default()
    }
}

fn subscribe(target: &str, path: &str, on_change: &str) -> ReducerOutput {
    ReducerOutput {
        subscribe_requests: vec![crate::module_host::SubscribeRequest {
            target: target.into(),
            path: path.into(),
            on_change: on_change.into(),
        }],
        ..Default::default()
    }
}

fn message(result: Result<(), EngineError>) -> String {
    match result {
        Err(EngineError::ModuleError(message)) => message,
        other => panic!("expected a ModuleError, got {other:?}"),
    }
}

fn scope(name: &str) -> ScopeName {
    ScopeName::parse(name).unwrap()
}

// ── the failure report: what ran, why, and why not ──────────────────────────

#[test]
fn an_acl_refusal_is_reported_with_the_grant_to_add() {
    let mut fx = Fixture::new();
    fx.module("cart", &["checkout"], ModuleGrants::none(), |_| {
        Ok(cross("Payments", "charge"))
    });
    fx.module("payments", &["charge"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });

    assert_eq!(
        message(fx.dispatch("cart", "checkout")),
        "module cascade from [cart] checkout finished with 1 failure(s):\n  \
         - [payments] 'charge' refused: 'cart' has no `dispatches` grant on 'payments' — add \
         \"payments\" to `dispatches` in the manifest of 'cart' (dispatched by 'cart')"
    );
    assert_eq!(fx.calls(), [(0, "checkout".to_string())]);

    let report = fx.report();
    assert_eq!(
        report.root(),
        &CascadeRoot::Dispatch {
            scope: scope("cart"),
            action: "checkout".into()
        }
    );
    let [failure] = report.failures() else {
        panic!("one failure: {report:?}")
    };
    assert_eq!(
        (failure.scope.as_str(), failure.action.as_str()),
        ("payments", "charge")
    );
    assert_eq!(
        failure.origin,
        Origin::CrossDispatch {
            from: scope("cart")
        }
    );
    assert!(matches!(
        &failure.cause,
        FailureCause::DispatchDenied { missing_grant } if missing_grant == "payments"
    ));
}

#[test]
fn budget_exhaustion_reports_the_first_dropped_action_and_how_many() {
    let mut fx = Fixture::new();
    fx.module("feed", &["refresh"], ModuleGrants::none(), |_| {
        Ok(emit(&["refresh", "refresh"]))
    });
    fx.hosted.set_dispatch_budget(3);

    assert_eq!(
        message(fx.dispatch("feed", "refresh")),
        "module cascade from [feed] refresh finished with 1 failure(s):\n  \
         - [feed] 'refresh' dropped: reducer-invocation budget (3) exhausted; dropped 4 pending \
         action(s), this one first (emitted by 'feed')"
    );
    assert_eq!(fx.calls().len(), 3);
    let failure = &fx.report().failures()[0];
    assert_eq!(failure.origin, Origin::Emit);
    assert!(matches!(
        failure.cause,
        FailureCause::BudgetExhausted {
            budget: 3,
            dropped: 4
        }
    ));
}

#[test]
fn a_trapped_follow_up_is_reported_with_its_origin_and_blocks_nothing() {
    let mut fx = Fixture::new();
    fx.module(
        "audit",
        &["watch", "cartChanged"],
        ModuleGrants::new(["cart"], [""; 0]),
        |seen| match seen.action.as_str() {
            "watch" => Ok(subscribe("cart", "items", "cartChanged")),
            _ => Err(HostError::Trap("wasm `unreachable` executed".into())),
        },
    );
    fx.module("cart", &["add", "recount"], ModuleGrants::none(), |seen| {
        Ok(match seen.action.as_str() {
            "add" => ReducerOutput {
                emit: vec![action("recount")],
                ..with_state(json!({ "items": [1] }))
            },
            _ => with_state(json!({ "items": [1], "count": 1 })),
        })
    });
    fx.dispatch("audit", "watch").unwrap();
    fx.calls();

    assert_eq!(
        message(fx.dispatch("cart", "add")),
        "module cascade from [cart] add finished with 1 failure(s):\n  \
         - [audit] 'cartChanged' failed: module trapped: wasm `unreachable` executed \
         (notification: 'cart' changed at 'items')"
    );
    // The emit queued before the notification ran, and so did the trap; the
    // state both of cart's steps returned stands.
    assert_eq!(
        fx.calls(),
        [
            (1, "add".to_string()),
            (1, "recount".to_string()),
            (0, "cartChanged".to_string())
        ]
    );
    assert_eq!(fx.state("cart"), json!({ "items": [1], "count": 1 }));
    let failure = &fx.report().failures()[0];
    assert_eq!(
        failure.origin,
        Origin::SubscriptionChange {
            target: "cart".into(),
            path: "items".into()
        }
    );
    assert!(matches!(
        failure.cause,
        FailureCause::Host(HostError::Trap(_))
    ));

    // A clean cascade clears the report.
    fx.dispatch("cart", "recount").unwrap();
    assert!(fx.hosted.last_report().is_none());
}

// ── host errors at each lifecycle point ─────────────────────────────────────

#[test]
fn a_trapped_instance_is_dead_at_every_later_entry_point() {
    let mut fx = Fixture::new();
    fx.module(
        "a",
        &["trap", "x"],
        ModuleGrants::none(),
        |seen| match seen.action.as_str() {
            "trap" => Err(HostError::Trap("out of fuel".into())),
            _ => Ok(with_state(json!({ "ran": true }))),
        },
    );
    fx.module("b", &["poke"], ModuleGrants::new([""; 0], ["a"]), |_| {
        Ok(ReducerOutput {
            cross_dispatch: vec![("a".into(), action("x"))],
            ..with_state(json!({ "poked": true }))
        })
    });

    assert_eq!(
        message(fx.dispatch("a", "trap")),
        "[a] 'trap' failed: module trapped: out of fuel"
    );
    // Root dispatch, both lifecycle hooks: the caller's error, nothing applied.
    assert_eq!(
        message(fx.dispatch("a", "x")),
        "[a] 'x' failed: module instance is dead"
    );
    assert!(matches!(
        fx.report().root_failure().map(|f| &f.cause),
        Some(FailureCause::Host(HostError::DeadInstance))
    ));
    assert_eq!(
        message(fx.lifecycle("a", LifecycleHook::Activated)),
        "[a] '<on_activated>' failed: module instance is dead"
    );
    assert_eq!(
        message(fx.lifecycle("a", LifecycleHook::Deactivated)),
        "[a] '<on_deactivated>' failed: module instance is dead"
    );
    assert_eq!(fx.state("a"), json!({}));

    // As a follow-up target: reported, and the sender's own output stands.
    let summary = message(fx.dispatch("b", "poke"));
    assert!(
        summary.ends_with("[a] 'x' failed: module instance is dead (dispatched by 'b')"),
        "{summary}"
    );
    assert_eq!(fx.state("b"), json!({ "poked": true }));

    // Destroy: the hook's error comes back, after a complete teardown.
    assert_eq!(
        message(fx.destroy("a")),
        "[a] '<on_destroyed>' failed: module instance is dead"
    );
    assert_eq!(fx.hosted.instance_id("a"), None);
    assert!(fx.core.get_module_state("a").is_none());
    assert!(matches!(
        fx.dispatch("a", "x"),
        Err(EngineError::ActionNotFound(_))
    ));
    fx.destroy("a").unwrap(); // idempotent
}

#[test]
fn without_a_module_host_calls_fail_and_teardown_still_completes() {
    let mut fx = Fixture::new();
    fx.hosted = HostedModules::new(); // no host installed
    fx.module("a", &["x"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });

    assert_eq!(
        message(fx.dispatch("a", "x")),
        "[a] 'x' failed: no module host installed"
    );
    assert!(matches!(
        fx.report().root_failure().map(|f| &f.cause),
        Some(FailureCause::NoHost)
    ));
    assert_eq!(
        message(fx.destroy("a")),
        "[a] '<on_destroyed>' failed: no module host installed"
    );
    assert_eq!(fx.hosted.instance_id("a"), None);
    assert!(fx.calls().is_empty());
}

#[test]
fn a_scope_whose_state_slot_vanished_fails_as_a_state_error() {
    let mut fx = Fixture::new();
    fx.module("a", &["x"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });
    // The embedder removed the scope's state behind the subsystem's back.
    crate::agent_core::unregister_module(&mut fx.core, "a");

    let err = fx.dispatch("a", "x").unwrap_err();
    assert_eq!(
        err,
        EngineError::StateError("[a] 'x' failed: module has no state slot".into())
    );
    assert!(fx.calls().is_empty(), "the reducer never ran");
    // Destroy still gives the instance its teardown call, with empty state.
    fx.destroy("a").unwrap();
    assert_eq!(fx.calls(), [(0, DESTROYED.to_string())]);
}

// ── guest-supplied data ─────────────────────────────────────────────────────

#[test]
fn a_follow_up_payload_must_be_json_and_an_empty_one_is_null() {
    let mut fx = Fixture::new();
    fx.module("a", &["go", "x"], ModuleGrants::none(), |seen| {
        Ok(match seen.action.as_str() {
            "go" => ReducerOutput {
                emit: vec![
                    HostAction::new("x", b"{oops".to_vec()),
                    HostAction::new("x", Vec::new()),
                    HostAction::new("x", br#"{"n":1}"#.to_vec()),
                ],
                ..Default::default()
            },
            _ => ReducerOutput::default(),
        })
    });

    let summary = message(fx.dispatch("a", "go"));
    assert!(
        summary.contains("1 failure(s)")
            && summary.contains("[a] 'x' refused: payload is not JSON"),
        "{summary}"
    );
    assert!(matches!(
        fx.report().failures()[0].cause,
        FailureCause::PayloadNotJson(_)
    ));
    // The malformed one never reached the reducer; the empty one arrived as
    // `null`, the valid one untouched.
    let payloads: Vec<String> = fx
        .script
        .lock()
        .unwrap()
        .seen
        .iter()
        .map(|s| s.payload.clone())
        .collect();
    assert_eq!(payloads, ["null", "null", r#"{"n":1}"#]);
}

#[test]
fn unusable_state_from_a_follow_up_rejects_that_output_only() {
    let mut fx = Fixture::new();
    fx.module(
        "a",
        &["go", "array", "garbage", "fine"],
        ModuleGrants::none(),
        |seen| {
            let rejected = |state: &[u8]| ReducerOutput {
                state: Some(state.to_vec()),
                // Nothing of a rejected output may run.
                emit: vec![action("never")],
                ..Default::default()
            };
            Ok(match seen.action.as_str() {
                "go" => emit(&["array", "garbage", "fine"]),
                "array" => rejected(b"[1,2]"),
                "garbage" => rejected(b"{not json"),
                _ => with_state(json!({ "fine": true })),
            })
        },
    );

    let summary = message(fx.dispatch("a", "go"));
    assert!(summary.contains("2 failure(s)"), "{summary}");
    assert!(
        summary.contains("[a] 'array' failed: module state must be a JSON object"),
        "{summary}"
    );
    assert!(
        summary.contains("[a] 'garbage' failed: invalid state:"),
        "{summary}"
    );
    let causes: Vec<&FailureCause> = fx.report().failures().iter().map(|f| &f.cause).collect();
    assert!(matches!(
        causes[..],
        [
            FailureCause::InvalidState(InvalidState::NotAnObject),
            FailureCause::InvalidState(InvalidState::NotJson(_))
        ]
    ));
    assert_eq!(fx.state("a"), json!({ "fine": true }));
    assert_eq!(fx.calls().len(), 4, "'never' was not queued");
}

#[test]
fn a_follow_up_to_an_unknown_or_unaccepting_module_names_which() {
    let mut fx = Fixture::new();
    fx.module(
        "a",
        &["go"],
        ModuleGrants::new([""; 0], ["ghost", "b"]),
        |_| {
            Ok(ReducerOutput {
                cross_dispatch: vec![("ghost".into(), action("x")), ("b".into(), action("nope"))],
                ..Default::default()
            })
        },
    );
    fx.module("b", &["x"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });

    let summary = message(fx.dispatch("a", "go"));
    assert!(
        summary.contains("[ghost] 'x' refused: no hosted module under scope 'ghost'"),
        "{summary}"
    );
    assert!(
        summary.contains("[b] 'nope' refused: module 'b' does not accept that action"),
        "{summary}"
    );
    let causes: Vec<&FailureCause> = fx.report().failures().iter().map(|f| &f.cause).collect();
    assert!(matches!(
        causes[..],
        [FailureCause::UnknownModule, FailureCause::NotAccepted]
    ));
}

#[test]
fn the_depth_cap_names_the_action_that_was_cut_off() {
    let mut fx = Fixture::new();
    fx.module("a", &["again"], ModuleGrants::none(), |_| {
        Ok(emit(&["again"]))
    });
    let summary = message(fx.dispatch("a", "again"));
    assert!(
        summary.ends_with("[a] 'again' dropped: cascade depth cap (32) reached (emitted by 'a')"),
        "{summary}"
    );
    assert_eq!(fx.calls().len(), MAX_CASCADE_DEPTH as usize);
    assert!(matches!(
        fx.report().failures()[0].cause,
        FailureCause::DepthExceeded {
            limit: MAX_CASCADE_DEPTH
        }
    ));
}

// ── registration ────────────────────────────────────────────────────────────

#[test]
fn registration_validates_names_before_changing_anything() {
    let mut fx = Fixture::new();
    fx.module("a", &["x"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });
    let mut register = |scope: &str, actions: &[&str], state: Value| {
        let actions = actions.iter().map(|a| a.to_string()).collect();
        let (hosted, mut ctx) = fx.parts();
        hosted.register(
            &mut ctx,
            scope,
            ModuleInstanceId(99),
            actions,
            ModuleGrants::none(),
            state,
        )
    };
    for (scope, actions) in [
        ("", &["x"][..]),
        ("a:b", &["x"]),
        ("__hypen_scoped", &["x"]),
        ("__HYPEN_x", &["x"]),
        ("a", &["b:x"]),
        ("a", &[""]),
        ("a", &["__hypen_dispatch"]),
    ] {
        let err = register(scope, actions, json!({})).unwrap_err();
        assert!(
            matches!(err, EngineError::ModuleError(_)),
            "{scope:?} {actions:?}: {err}"
        );
    }
    let err = register("a", &["x"], json!([1])).unwrap_err();
    assert!(matches!(err, EngineError::StateError(_)), "{err}");

    // The module wired before all those attempts is untouched.
    assert_eq!(fx.hosted.instance_id("A"), Some(ModuleInstanceId(0)));
    fx.dispatch("a", "x").unwrap();
}

#[test]
fn registering_a_scope_again_replaces_the_instance_and_reseeds_its_state() {
    let mut fx = Fixture::new();
    fx.module(
        "a",
        &["old", "watch", "changed"],
        ModuleGrants::new(["t"], [""; 0]),
        |seen| {
            Ok(match seen.action.as_str() {
                "watch" => subscribe("t", "", "changed"),
                _ => with_state(json!({ "old": true })),
            })
        },
    );
    fx.module("t", &["bump"], ModuleGrants::none(), |_| {
        Ok(with_state(json!({ "n": 1 })))
    });
    fx.dispatch("a", "watch").unwrap();
    fx.dispatch("a", "old").unwrap();
    assert_eq!(fx.state("a"), json!({ "old": true }));

    let replacement = fx.module("A", &["new"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });
    assert_eq!(
        fx.hosted.instance_id("a"),
        Some(ModuleInstanceId(replacement))
    );
    assert_eq!(fx.state("a"), json!({}), "a fresh state slot");
    assert!(
        matches!(fx.dispatch("a", "old"), Err(EngineError::ActionNotFound(_))),
        "the old action set is gone"
    );
    // The old instance's subscription went with it.
    fx.calls();
    fx.dispatch("t", "bump").unwrap();
    assert_eq!(fx.calls(), [(1, "bump".to_string())]);
}

#[test]
fn rewiring_an_unknown_scope_is_an_error_that_wires_nothing() {
    let mut fx = Fixture::new();
    let (hosted, mut ctx) = fx.parts();
    let err = hosted
        .rewire(
            &mut ctx,
            "ghost",
            ModuleInstanceId(1),
            vec!["x".into()],
            ModuleGrants::none(),
        )
        .unwrap_err();
    assert_eq!(
        err,
        EngineError::ModuleError(
            "[ghost] cannot rewire: no module state registered under this scope".into()
        )
    );
    assert!(fx.hosted.is_empty());
    assert!(fx.core.registered_actions.is_empty());
}

#[test]
fn the_instance_table_cannot_change_while_a_cascade_drains() {
    let mut fx = Fixture::new();
    fx.module("a", &["x"], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });
    // Unreachable through `Engine` (nothing hands out `&mut Engine` during a
    // drain); the guard is what a future regression would hit.
    fx.hosted.cascade_state = CascadeState::Draining;

    let (hosted, mut ctx) = fx.parts();
    let attempts = [
        hosted.register(
            &mut ctx,
            "b",
            ModuleInstanceId(5),
            vec![],
            ModuleGrants::none(),
            json!({}),
        ),
        hosted.rewire(
            &mut ctx,
            "a",
            ModuleInstanceId(5),
            vec![],
            ModuleGrants::none(),
        ),
        hosted.destroy(&mut ctx, "a"),
        hosted.dispatch_trusted(&mut ctx, "a", "x", Value::Null),
        hosted.run_lifecycle(&mut ctx, "a", LifecycleHook::Activated),
    ];
    for attempt in attempts {
        let reason = message(attempt);
        assert!(
            reason.ends_with("called while a module dispatch cascade is running"),
            "{reason}"
        );
    }
    assert_eq!(fx.hosted.instance_id("a"), Some(ModuleInstanceId(0)));
    assert_eq!(fx.hosted.instance_id("b"), None);
    assert!(fx.calls().is_empty());
}

// ── subscriptions and host writes ───────────────────────────────────────────

#[test]
fn host_write_notification_failures_are_kept_in_the_report() {
    let mut fx = Fixture::new();
    fx.module(
        "w",
        &["watch", "changed"],
        ModuleGrants::new(["t"], [""; 0]),
        |seen| match seen.action.as_str() {
            "watch" => Ok(subscribe("t", "n", "changed")),
            _ => Err(HostError::ModuleError("cannot cope".into())),
        },
    );
    fx.module("t", &[], ModuleGrants::none(), |_| {
        Ok(ReducerOutput::default())
    });
    fx.dispatch("w", "watch").unwrap();
    fx.calls();

    fx.host_write("t", json!({ "n": 1 }));
    assert_eq!(fx.calls(), [(0, "changed".to_string())]);
    assert_eq!(fx.state("t"), json!({ "n": 1 }), "the write stands");
    let report = fx.report();
    assert_eq!(report.root(), &CascadeRoot::HostWrite { scope: "t".into() });
    assert_eq!(
        report.to_string(),
        "module cascade from [t] <host state update> finished with 1 failure(s):\n  \
         - [w] 'changed' failed: module returned error: cannot cope (notification: 't' changed \
         at 'n')"
    );
    assert_eq!(fx.hosted.cascade_state, CascadeState::Idle);

    // A write nothing watches costs no cascade and leaves the report alone.
    fx.host_write("t", json!({ "other": 1 }));
    assert!(fx.calls().is_empty());
    assert!(fx.hosted.last_report().is_some());
}

#[test]
fn a_subscription_outlives_neither_a_destroyed_target_nor_a_removed_plain_scope() {
    let mut fx = Fixture::new();
    // `plain` is a closure-backed scope: readable and watchable, not hosted.
    fx.core.register_module(
        "plain",
        ModuleInstance::new(Module::new("plain"), json!({ "n": 0 })),
    );
    fx.module(
        "w",
        &["watch", "changed"],
        ModuleGrants::new(["t", "plain"], [""; 0]),
        |seen| {
            Ok(match seen.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: [
                        subscribe("t", "", "changed"),
                        subscribe("plain", "n", "changed"),
                    ]
                    .into_iter()
                    .flat_map(|output| output.subscribe_requests)
                    .collect(),
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        },
    );
    fx.module("t", &["bump"], ModuleGrants::none(), |_| {
        Ok(with_state(json!({ "n": 1 })))
    });
    fx.dispatch("w", "watch").unwrap();
    fx.calls();

    fx.host_write("plain", json!({ "n": 1 }));
    assert_eq!(fx.calls(), [(0, "changed".to_string())]);

    // The plain scope is removed without the subsystem hearing of it: the
    // stale subscription matches no state and can never fire.
    crate::agent_core::unregister_module(&mut fx.core, "plain");
    let notice = fx
        .hosted
        .host_write_notice(&fx.core, Some("plain"), |_, changed| {
            changed.push("n".into())
        });
    assert!(notice.is_none());

    // A destroyed hosted target takes the subscriptions on it along: a new
    // module under the same name does not inherit the old one's observers.
    fx.destroy("t").unwrap();
    fx.module("t", &["bump"], ModuleGrants::none(), |_| {
        Ok(with_state(json!({ "n": 2 })))
    });
    fx.calls();
    fx.dispatch("t", "bump").unwrap();
    assert_eq!(fx.calls(), [(2, "bump".to_string())]);
}

// ── effects and closure fallback ────────────────────────────────────────────

#[test]
fn effects_the_engine_cannot_perform_are_dropped_without_failing_the_dispatch() {
    let effects = || ReducerOutput {
        effects: vec![
            Effect::Log {
                level: crate::module_host::LogLevel::Info,
                message: "hello".into(),
            },
            Effect::Navigate("/next".into()),
            Effect::Delay {
                ms: 5,
                then: "x".into(),
            },
        ],
        ..Default::default()
    };
    let mut fx = Fixture::new();
    fx.module("a", &["x"], ModuleGrants::none(), move |_| Ok(effects()));

    // No handler: Navigate/Delay are logged and dropped; the dispatch is fine.
    fx.dispatch("a", "x").unwrap();
    assert!(fx.hosted.last_report().is_none());

    // With a handler: it gets exactly the two host-performed effects, tagged
    // with the originating scope. `Log` stays engine-side.
    let performed = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&performed);
    fx.hosted.set_effect_handler(Box::new(move |scope, effect| {
        sink.lock().unwrap().push(format!("{scope}: {effect:?}"));
    }));
    fx.dispatch("a", "x").unwrap();
    assert_eq!(
        *performed.lock().unwrap(),
        [
            r#"a: Navigate("/next")"#,
            r#"a: Delay { ms: 5, then: "x" }"#
        ]
    );
}

#[test]
fn a_routed_action_no_hosted_module_takes_goes_to_the_closure_dispatcher() {
    let mut fx = Fixture::new();
    fx.module("a", &["x"], ModuleGrants::none(), |_| {
        Ok(with_state(json!({ "ran": true })))
    });
    let hits = Arc::new(Mutex::new(0));
    let sink = Arc::clone(&hits);
    fx.closures.on("plain", move |_| *sink.lock().unwrap() += 1);
    fx.core.note_handler("plain");

    let (hosted, mut ctx) = fx.parts();
    hosted
        .dispatch_ui_action(&mut ctx, Action::new("plain"))
        .unwrap();
    hosted
        .dispatch_ui_action(&mut ctx, Action::new("x"))
        .unwrap();
    let unknown = hosted
        .dispatch_ui_action(&mut ctx, Action::new("nobody"))
        .unwrap_err();
    assert!(
        matches!(unknown, EngineError::ActionNotFound(_)),
        "{unknown}"
    );

    assert_eq!(*hits.lock().unwrap(), 1);
    assert_eq!(fx.calls(), [(0, "x".to_string())]);
    assert_eq!(fx.state("a"), json!({ "ran": true }));
}

// ── in-process (closure) scopes next to hosted ones ─────────────────────────

/// What an in-process handler was handed.
type Delivered = Arc<Mutex<Vec<(String, Value, Option<String>)>>>;

impl Fixture {
    /// Register a closure-backed module `scope` with `state` and a handler
    /// for each of `actions` under the scope's wire name, as an SDK does.
    fn plain_module(&mut self, scope: &str, state: Value, actions: &[&str]) -> Delivered {
        let delivered = Delivered::default();
        self.core
            .register_module(scope, ModuleInstance::new(Module::new(scope), state));
        for action in actions {
            let wire = crate::action_routing::scoped_action_name(scope, action);
            self.core.note_handler(&wire);
            let sink = Arc::clone(&delivered);
            self.closures.on(wire, move |action: &Action| {
                sink.lock().unwrap().push((
                    action.name.clone(),
                    action.payload.clone().unwrap_or(Value::Null),
                    action.sender.clone(),
                ));
            });
        }
        delivered
    }
}

fn cross_with(target: &str, name: &str, payload: &[u8]) -> ReducerOutput {
    ReducerOutput {
        cross_dispatch: vec![(target.to_string(), HostAction::new(name, payload.to_vec()))],
        ..Default::default()
    }
}

#[test]
fn a_granted_cross_dispatch_reaches_an_in_process_handler() {
    let mut fx = Fixture::new();
    let delivered = fx.plain_module("Shell", json!({}), &["toast"]);
    fx.module(
        "cart",
        &["checkout"],
        ModuleGrants::new([""; 0], ["shell"]),
        |_| Ok(cross_with("Shell", "toast", br#"{"text":"paid"}"#)),
    );

    fx.dispatch("cart", "checkout").unwrap();
    assert!(fx.hosted.last_report().is_none());
    assert_eq!(
        *delivered.lock().unwrap(),
        [(
            "__hypen_scoped:shell:toast".to_string(),
            json!({ "text": "paid" }),
            Some("cart".to_string()),
        )],
        "the handler gets its wire name, the decoded payload and the sender"
    );
    assert_eq!(fx.calls(), [(0, "checkout".to_string())]);
}

#[test]
fn a_cross_dispatch_to_an_in_process_scope_needs_the_dispatches_grant() {
    let mut fx = Fixture::new();
    let delivered = fx.plain_module("shell", json!({}), &["toast"]);
    // `reads` is not `dispatches`.
    fx.module(
        "cart",
        &["checkout"],
        ModuleGrants::new(["shell"], [""; 0]),
        |_| Ok(cross("shell", "toast")),
    );

    let summary = message(fx.dispatch("cart", "checkout"));
    assert!(
        summary.ends_with(
            "[shell] 'toast' refused: 'cart' has no `dispatches` grant on 'shell' — add \
             \"shell\" to `dispatches` in the manifest of 'cart' (dispatched by 'cart')"
        ),
        "{summary}"
    );
    assert!(delivered.lock().unwrap().is_empty());
    assert!(matches!(
        &fx.report().failures()[0].cause,
        FailureCause::DispatchDenied { missing_grant } if missing_grant == "shell"
    ));
}

#[test]
fn a_cross_dispatch_to_an_in_process_scope_names_what_is_missing() {
    let mut fx = Fixture::new();
    let delivered = fx.plain_module("shell", json!({}), &["toast", "__hypen_bind"]);
    fx.module(
        "cart",
        &["go"],
        ModuleGrants::new([""; 0], ["shell", "ghost", "a:b"]),
        |_| {
            Ok(ReducerOutput {
                cross_dispatch: vec![
                    ("shell".into(), action("nope")),
                    ("ghost".into(), action("toast")),
                    // Reserved protocol actions are never deliverable, even
                    // with a handler registered and the grant held.
                    ("shell".into(), action("__hypen_bind")),
                    // Neither a target nor a name may alias a wire name.
                    ("shell".into(), action("x:toast")),
                    ("a:b".into(), action("toast")),
                    (
                        "shell".into(),
                        HostAction::new("toast", b"{not json".to_vec()),
                    ),
                    ("shell".into(), HostAction::new("toast", Vec::new())),
                ],
                ..Default::default()
            })
        },
    );

    let summary = message(fx.dispatch("cart", "go"));
    assert!(
        summary.contains("[shell] 'nope' refused: module 'shell' does not accept that action"),
        "{summary}"
    );
    assert!(
        summary.contains("[ghost] 'toast' refused: no hosted module under scope 'ghost'"),
        "{summary}"
    );
    let causes: Vec<&FailureCause> = fx.report().failures().iter().map(|f| &f.cause).collect();
    assert!(
        matches!(
            causes[..],
            [
                FailureCause::NotAccepted,
                FailureCause::UnknownModule,
                FailureCause::NotAccepted,
                FailureCause::NotAccepted,
                FailureCause::UnknownModule,
                FailureCause::PayloadNotJson(_),
            ]
        ),
        "{causes:?}"
    );
    assert_eq!(
        *delivered.lock().unwrap(),
        [(
            "__hypen_scoped:shell:toast".to_string(),
            Value::Null,
            Some("cart".to_string())
        )],
        "only the well-formed one ran, its empty payload as null"
    );
}

#[test]
fn in_process_deliveries_spend_the_budget_and_keep_queue_order() {
    let mut fx = Fixture::new();
    let delivered = fx.plain_module("shell", json!({}), &["toast"]);
    fx.module(
        "cart",
        &["go", "after"],
        ModuleGrants::new([""; 0], ["shell"]),
        |seen| match seen.action.as_str() {
            "go" => Ok(ReducerOutput {
                emit: vec![action("after")],
                cross_dispatch: vec![
                    ("shell".into(), action("toast")),
                    ("shell".into(), action("toast")),
                    ("shell".into(), action("toast")),
                ],
                ..Default::default()
            }),
            _ => Ok(ReducerOutput::default()),
        },
    );

    // Root + `after` + one delivery fit; the other two are dropped.
    fx.hosted.set_dispatch_budget(3);
    let summary = message(fx.dispatch("cart", "go"));
    assert!(
        summary.ends_with(
            "[shell] 'toast' dropped: reducer-invocation budget (3) exhausted; dropped 2 \
             pending action(s), this one first (dispatched by 'cart')"
        ),
        "{summary}"
    );
    assert_eq!(delivered.lock().unwrap().len(), 1);
    assert_eq!(
        fx.calls(),
        [(0, "go".to_string()), (0, "after".to_string())],
        "emit is queued before cross-dispatch"
    );

    // With room for all of it nothing is reported.
    fx.hosted.set_dispatch_budget(5);
    fx.dispatch("cart", "go").unwrap();
    assert_eq!(delivered.lock().unwrap().len(), 4);
}

#[test]
fn a_failing_in_process_handler_is_reported_and_blocks_nothing() {
    /// Handlers that refuse `boom`, as a binding whose handler threw would.
    struct Flaky(ActionDispatcher);
    impl ClosureActions for Flaky {
        fn has_handler(&self, name: &str) -> bool {
            ClosureActions::has_handler(&self.0, name)
        }
        fn dispatch_ui(&self, core: &EngineCore, action: Action) -> Result<(), EngineError> {
            self.0.dispatch_ui(core, action)
        }
        fn deliver(&self, action: &Action) -> Result<(), String> {
            if action.name.ends_with(":boom") {
                return Err("TypeError: x is undefined".into());
            }
            self.0.deliver(action)
        }
    }

    let mut fx = Fixture::new();
    let delivered = fx.plain_module("shell", json!({}), &["boom", "toast"]);
    fx.module(
        "cart",
        &["go"],
        ModuleGrants::new([""; 0], ["shell"]),
        |_| {
            Ok(ReducerOutput {
                state: Some(br#"{"done":true}"#.to_vec()),
                cross_dispatch: vec![
                    ("shell".into(), action("boom")),
                    ("shell".into(), action("toast")),
                ],
                ..Default::default()
            })
        },
    );

    let flaky = Flaky(std::mem::take(&mut fx.closures));
    let mut ctx = EngineCtx {
        core: &mut fx.core,
        closures: &flaky,
        patches: &mut fx.patches,
    };
    let result = fx
        .hosted
        .dispatch_trusted(&mut ctx, "cart", "go", Value::Null);
    assert_eq!(
        message(result),
        "module cascade from [cart] go finished with 1 failure(s):\n  \
         - [shell] 'boom' failed: the in-process handler failed: TypeError: x is undefined \
         (dispatched by 'cart')"
    );
    assert_eq!(delivered.lock().unwrap().len(), 1, "'toast' still ran");
    assert_eq!(fx.state("cart"), json!({ "done": true }));
    let failure = &fx.report().failures()[0];
    assert!(matches!(failure.cause, FailureCause::Handler(_)));
    assert_eq!(
        failure.to_json(),
        json!({
            "scope": "shell",
            "action": "boom",
            "outcome": "failed",
            "isRoot": false,
            "origin": { "kind": "crossDispatch", "from": "cart" },
            "cause": { "code": "handler", "detail": "TypeError: x is undefined" },
            "message": "[shell] 'boom' failed: the in-process handler failed: TypeError: x is \
                        undefined (dispatched by 'cart')",
        })
    );
}

#[test]
fn a_reads_grant_hands_over_an_in_process_scopes_state() {
    let mut fx = Fixture::new();
    fx.plain_module("session", json!({ "user": "ada" }), &[]);
    fx.plain_module("secrets", json!({ "token": "t0p" }), &[]);
    fx.module(
        "profile",
        &["load"],
        ModuleGrants::new(["Session"], [""; 0]),
        |seen| {
            let user = seen.siblings.iter().find(|(scope, _)| scope == "session");
            Ok(with_state(json!({
                "user": user.map(|(_, state)| state["user"].clone()),
                "seen": seen.siblings.iter().map(|(scope, _)| scope.clone()).collect::<Vec<_>>(),
            })))
        },
    );
    fx.module("blind", &["load"], ModuleGrants::none(), |seen| {
        Ok(with_state(json!({ "siblings": seen.siblings.len() })))
    });

    fx.dispatch("profile", "load").unwrap();
    assert_eq!(
        fx.state("profile"),
        json!({ "user": "ada", "seen": ["session"] }),
        "only the granted scope, never 'secrets'"
    );
    fx.dispatch("blind", "load").unwrap();
    assert_eq!(fx.state("blind"), json!({ "siblings": 0 }));

    // The snapshot follows host writes to the in-process scope.
    fx.host_write("session", json!({ "user": "grace" }));
    fx.dispatch("profile", "load").unwrap();
    assert_eq!(fx.state("profile")["user"], "grace");
}

#[test]
fn a_host_write_to_an_in_process_scope_notifies_its_hosted_subscribers() {
    let mut fx = Fixture::new();
    fx.plain_module("session", json!({ "user": "ada", "theme": "dark" }), &[]);
    fx.module(
        "profile",
        &["watch", "userChanged"],
        ModuleGrants::new(["session"], [""; 0]),
        |seen| match seen.action.as_str() {
            "watch" => Ok(subscribe("session", "user", "userChanged")),
            _ => Ok(with_state(json!({ "user": seen.siblings[0].1["user"] }))),
        },
    );
    fx.module("nosy", &["watch", "x"], ModuleGrants::none(), |_| {
        Ok(subscribe("session", "user", "x"))
    });
    fx.dispatch("profile", "watch").unwrap();
    let refused = message(fx.dispatch("nosy", "watch"));
    assert!(
        refused.contains("subscribe to 'session' at 'user' refused: no `reads` grant on 'session'"),
        "{refused}"
    );
    fx.calls();

    fx.host_write("session", json!({ "theme": "light" }));
    assert!(fx.calls().is_empty(), "another path changed");

    fx.host_write("session", json!({ "user": "grace" }));
    assert_eq!(fx.calls(), [(0, "userChanged".to_string())]);
    assert_eq!(
        fx.state("profile"),
        json!({ "user": "grace" }),
        "the subscriber read the written state"
    );
    assert!(fx.hosted.last_report().is_none());
}

#[test]
fn the_report_as_json_names_root_origin_and_cause() {
    let mut fx = Fixture::new();
    fx.module("cart", &["go"], ModuleGrants::none(), |_| {
        Ok(cross("payments", "charge"))
    });
    fx.dispatch("cart", "go").unwrap_err();
    assert_eq!(
        fx.report().to_json(),
        json!({
            "root": { "kind": "dispatch", "scope": "cart", "action": "go" },
            "rootFailed": false,
            "failureCount": 1,
            "failures": [{
                "scope": "payments",
                "action": "charge",
                "outcome": "refused",
                "isRoot": false,
                "origin": { "kind": "crossDispatch", "from": "cart" },
                "cause": {
                    "code": "dispatchDenied",
                    "grant": "dispatches",
                    "missingGrant": "payments",
                },
                "message": "[payments] 'charge' refused: 'cart' has no `dispatches` grant on \
                            'payments' — add \"payments\" to `dispatches` in the manifest of \
                            'cart' (dispatched by 'cart')",
            }],
            "message": "Module error: module cascade from [cart] go finished with 1 \
                        failure(s):\n  - [payments] 'charge' refused: 'cart' has no \
                        `dispatches` grant on 'payments' — add \"payments\" to `dispatches` in \
                        the manifest of 'cart' (dispatched by 'cart')",
        })
    );

    // A failing root.
    fx.module("dead", &["go"], ModuleGrants::none(), |_| {
        Err(HostError::Trap("unreachable".into()))
    });
    fx.dispatch("dead", "go").unwrap_err();
    let report = fx.report().to_json();
    assert_eq!(report["rootFailed"], true);
    assert_eq!(report["failures"][0]["origin"], json!({ "kind": "root" }));
    assert_eq!(
        report["failures"][0]["cause"],
        json!({
            "code": "host",
            "host": { "code": "trap", "message": "module trapped: unreachable" },
        })
    );
    assert_eq!(
        fx.hosted.describe(),
        [
            HostedModuleInfo {
                scope: "cart".into(),
                actions: vec!["go".into()],
                wildcard: false
            },
            HostedModuleInfo {
                scope: "dead".into(),
                actions: vec!["go".into()],
                wildcard: false
            },
        ]
    );
}
