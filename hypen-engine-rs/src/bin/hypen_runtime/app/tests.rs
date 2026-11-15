//! Runtime behaviour against the fake host: boot, dispatch routing, exact
//! patch attribution, hot reload, crash recovery — no wasm, no sockets.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::testing::{fake_host, FakeHandle};
use super::*;
use crate::cli::Grants;
use crate::names::ScopeName;
use crate::patches::Subscription;
use crate::reload::ReloadEvent;

const COUNTER_UI: &str = "module Counter(start: 0) {\n  Column {\n    Text(\"Counter: @{state.count}\")\n    Button(\"@actions.increment\") { Text(\"+1\") }\n  }\n}\n";

fn app_ui(extra: &str) -> String {
    format!("module App {{\n  Column {{\n    Text(\"App: @{{state.count}}\")\n    Counter()\n{extra}  }}\n}}\n")
}

/// A two-module app on disk (both modules backed by `a.wasm`), booted on the
/// fake host.
struct TestApp {
    dir: tempfile::TempDir,
    host: FakeHandle,
    runtime: Runtime,
    initial: Vec<Patch>,
}

impl TestApp {
    fn path(&self, file: &str) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap().join(file)
    }

    /// Rewrite a file and tell the runtime, as the watcher would.
    fn edit(&self, file: &str, contents: &str) -> Vec<ReloadEvent> {
        std::fs::write(self.path(file), contents).unwrap();
        self.runtime.files_changed(&[self.path(file)])
    }

    fn count(&self, scope: &str) -> Value {
        self.runtime.module_state(scope)["count"].clone()
    }
}

fn write_app(dir: &tempfile::TempDir) -> PathBuf {
    std::fs::write(dir.path().join("a.wasm"), b"v1").unwrap();
    std::fs::write(dir.path().join("app.hypen"), app_ui("")).unwrap();
    std::fs::write(dir.path().join("counter.hypen"), COUNTER_UI).unwrap();
    let manifest = dir.path().join("app.json");
    std::fs::write(
        &manifest,
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "a.wasm", "ui": "app.hypen" },
            { "name": "Counter", "wasm": "a.wasm", "ui": "counter.hypen" } ] }"#,
    )
    .unwrap();
    manifest
}

fn boot_app() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let manifest = write_app(&dir);
    let (host, handle) = fake_host();
    let booted = Runtime::boot_with_host(&Source::App { manifest }, host).expect("boot");
    TestApp {
        dir,
        host: handle,
        runtime: booted.runtime,
        initial: booted.initial_patches.expect("app mode has a UI"),
    }
}

fn request(name: &str) -> DispatchRequest {
    DispatchRequest::new(name, json!({}), None)
}

fn text(patches: &[Patch]) -> String {
    serde_json::to_string(patches).unwrap()
}

fn frames(sub: &Subscription) -> Vec<String> {
    sub.frames.try_iter().map(|f| f.to_string()).collect()
}

// ── boot ────────────────────────────────────────────────────────────────────

#[test]
fn app_boots_one_instance_per_module_and_renders_the_entry() {
    let app = boot_app();
    assert_eq!(app.runtime.entry_scope(), "app");
    assert_eq!(app.host.instance_count(), 2);
    let initial = text(&app.initial);
    assert!(initial.contains("App: 0") && initial.contains("Counter: 0"), "{initial}");

    let envelope = app.runtime.state_envelope();
    assert_eq!(envelope["scope"], "app");
    assert_eq!(envelope["state"], json!({ "count": 0 }));
    assert_eq!(envelope["states"]["counter"], json!({ "count": 0 }));
    assert_eq!(
        envelope["actions"],
        json!(["crash", "delay", "fail", "increment", "nav"]),
        "sorted union across modules"
    );
}

#[test]
fn single_module_boot_seeds_init_from_the_ui_declaration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("m.wasm"), b"v1").unwrap();
    std::fs::write(
        dir.path().join("ui.hypen"),
        "module seeded(start: 7) { Text(\"Seeded: @{state.count}\") }",
    )
    .unwrap();
    let source = Source::Module(ModuleSource {
        wasm: dir.path().join("m.wasm"),
        scope: ScopeName::new("seeded").unwrap(),
        ui: Some(dir.path().join("ui.hypen")),
        actions: ActionSource::Override(vec!["increment".into()]),
        grants: Grants::default(),
    });
    let (host, _handle) = fake_host();
    let booted = Runtime::boot_with_host(&source, host).unwrap();
    assert!(text(&booted.initial_patches.unwrap()).contains("Seeded: 7"));
    let envelope = booted.runtime.state_envelope();
    assert_eq!(envelope["state"], json!({ "count": 7 }));
    assert_eq!(envelope["actions"], json!(["increment"]), "--actions override is used as given");
}

#[test]
fn boot_without_a_ui_has_no_patches_to_report() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("m.wasm"), b"v1").unwrap();
    let source = Source::Module(ModuleSource {
        wasm: dir.path().join("m.wasm"),
        scope: ScopeName::new("m").unwrap(),
        ui: None,
        actions: ActionSource::Discover,
        grants: Grants::default(),
    });
    let (host, _handle) = fake_host();
    let booted = Runtime::boot_with_host(&source, host).unwrap();
    assert!(booted.initial_patches.is_none());
    assert!(booted.runtime.tree_snapshot().is_empty());
    let outcome = booted.runtime.dispatch(&request("increment"));
    assert!(outcome.result.is_ok());
    assert!(outcome.patches.is_empty());
    assert_eq!(outcome.state.entry, json!({ "count": 1 }));
}

#[test]
fn boot_errors_carry_the_file_and_the_module() {
    // Missing .wasm → an Io error naming the path.
    let dir = tempfile::tempdir().unwrap();
    let source = Source::Module(ModuleSource {
        wasm: dir.path().join("missing.wasm"),
        scope: ScopeName::new("m").unwrap(),
        ui: None,
        actions: ActionSource::Discover,
        grants: Grants::default(),
    });
    let (host, _handle) = fake_host();
    let err = Runtime::boot_with_host(&source, host).err().expect("boot fails");
    assert!(matches!(err, RuntimeError::Io { action: "read", .. }), "{err}");
    assert!(err.to_string().contains("missing.wasm"));

    // An ungranted import → a Module error with a capability hint phrased for
    // the grant surface in use.
    std::fs::write(dir.path().join("m.wasm"), b"v1").unwrap();
    let source = Source::Module(ModuleSource {
        wasm: dir.path().join("m.wasm"),
        scope: ScopeName::new("m").unwrap(),
        ui: None,
        actions: ActionSource::Discover,
        grants: Grants::default(),
    });
    let (host, handle) = fake_host();
    handle.fail_instantiate("m");
    let err = Runtime::boot_with_host(&source, host).err().expect("boot fails");
    assert!(
        matches!(err, RuntimeError::Module { ref scope, stage: ModuleStage::Instantiate, .. } if scope == "m"),
        "{err}"
    );
    let rendered = crate::error::render(&err);
    assert!(rendered.contains("caused by: instantiation failed"), "{rendered}");
    assert!(rendered.contains("hint: ") && rendered.contains("--grant-http"), "{rendered}");
}

// ── dispatch routing ────────────────────────────────────────────────────────

#[test]
fn scoped_bare_and_sender_addressing() {
    let app = boot_app();

    // `Scope:action` addresses one module.
    let outcome = app.runtime.dispatch(&request("Counter:increment"));
    assert!(outcome.result.is_ok());
    assert_eq!(app.count("counter"), 1);
    assert_eq!(app.count("app"), 0);
    assert_eq!(outcome.state.entry, json!({ "count": 0 }), "entry state is the App's");
    assert_eq!(outcome.state.scopes["counter"], json!({ "count": 1 }));

    // A bare name two scopes handle is ambiguous — refused, never a guess.
    let outcome = app.runtime.dispatch(&request("increment"));
    let err = outcome.result.expect_err("ambiguous");
    assert!(
        matches!(err, RuntimeError::AmbiguousAction { ref action, ref candidates }
            if action == "increment" && candidates == &["app:increment", "counter:increment"]),
        "{err}"
    );
    assert!(err.to_string().contains("`app:increment`, `counter:increment`"), "{err}");
    assert_eq!((app.count("app"), app.count("counter")), (json!(0), json!(1)));

    // A sender node id resolves the owning scope: the only Button is the
    // Counter's.
    let snapshot = serde_json::to_value(app.runtime.tree_snapshot()).unwrap();
    let button = snapshot
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["type"] == "create" && p["elementType"] == "Button")
        .and_then(|p| p["id"].as_str())
        .expect("a Button in the tree")
        .to_string();
    let outcome =
        app.runtime.dispatch(&DispatchRequest::new("increment", json!({}), Some(button.clone())));
    assert!(outcome.result.is_ok());
    assert_eq!((app.count("app"), app.count("counter")), (json!(0), json!(2)));

    // The engine's own envelope (what the reference client sends) does the same.
    let envelope = json!({ "node": button, "action": "increment", "payload": {} });
    let outcome = app.runtime.dispatch(&DispatchRequest::new("__hypen_dispatch", envelope, None));
    assert!(outcome.result.is_ok(), "{:?}", outcome.result.err().map(|e| e.to_string()));
    assert_eq!(app.count("counter"), 3);

    // Unknown scope / action.
    let outcome = app.runtime.dispatch(&request("ghost:increment"));
    let err = outcome.result.expect_err("unknown scope");
    assert!(
        matches!(err, RuntimeError::UnknownAction {
            ref candidates, engine: EngineError::ActionNotFound(_), ..
        } if candidates == &["app:increment", "counter:increment"]),
        "{err}"
    );
    let outcome = app.runtime.dispatch(&request("Counter:frobnicate"));
    let err = outcome.result.expect_err("unknown action");
    assert!(
        matches!(err, RuntimeError::UnknownAction {
            ref candidates, engine: EngineError::ActionNotFound(_), ..
        } if candidates.contains(&"counter:increment".to_string())
            && candidates.iter().all(|c| c.starts_with("counter:"))),
        "{err}"
    );
    assert!(err.to_string().contains("'frobnicate'; did you mean `counter:"), "{err}");
    // A bare name nobody exports: everything there is, capped.
    let outcome = app.runtime.dispatch(&request("frobnicate"));
    let err = outcome.result.expect_err("unknown bare action");
    assert!(
        matches!(err, RuntimeError::UnknownAction { ref candidates, .. }
            if candidates.len() == 10 && candidates[0] == "app:increment"),
        "{err}"
    );
}

#[test]
fn a_reducer_error_is_a_module_error_not_a_crash() {
    let app = boot_app();
    let outcome = app.runtime.dispatch(&request("Counter:fail"));
    assert!(
        matches!(outcome.result, Err(RuntimeError::Dispatch(EngineError::ModuleError(_)))),
        "{:?}",
        outcome.result.err().map(|e| e.to_string())
    );
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 1, "the instance survived and kept working");
}

#[test]
fn effects_are_returned_to_the_caller() {
    let app = boot_app();
    let outcome = app.runtime.dispatch(&request("Counter:nav"));
    assert_eq!(outcome.effects.navigations, vec!["/next"]);
    let outcome = app.runtime.dispatch(&request("Counter:delay"));
    assert_eq!(outcome.effects.delays.len(), 1);
    assert_eq!(outcome.effects.delays[0].scope, "counter");
    assert_eq!(outcome.effects.delays[0].action, "increment");
    // Drained: the next dispatch does not see them again.
    assert_eq!(app.runtime.dispatch(&request("Counter:increment")).effects, HostEffects::default());
}

// ── patch attribution (defect 4) ────────────────────────────────────────────

#[test]
fn dispatch_patches_and_out_of_band_patches_never_mix() {
    let app = boot_app();
    let sub = app.runtime.subscribe().unwrap();

    // Out-of-band render #1: a template hot reload.
    app.edit("app.hypen", &app_ui("    Text(\"reload-one\")\n"));
    // A dispatch.
    let outcome = app.runtime.dispatch(&request("Counter:increment"));
    // Out-of-band render #2: a timer firing right after the dispatch
    // returned — the window in which the old code double-delivered.
    app.runtime.fire_timer("counter", "increment");

    let delta = text(&outcome.patches);
    assert_eq!(outcome.patches.len(), 1, "one SetProp: {delta}");
    assert!(delta.contains("Counter: 1"));
    assert!(!delta.contains("reload-one") && !delta.contains("Counter: 2"), "{delta}");

    let pushed = frames(&sub);
    assert_eq!(pushed.len(), 2, "{pushed:?}");
    assert!(pushed[0].contains("reload-one"));
    assert!(pushed[1].contains("Counter: 2"));
    assert!(pushed.iter().all(|f| !f.contains("Counter: 1")), "dispatch delta was pushed: {pushed:?}");

    // And the snapshot reflects all three.
    let tree = text(&app.runtime.tree_snapshot());
    assert!(tree.contains("reload-one") && tree.contains("Counter: 2"), "{tree}");
}

/// The same property under real concurrency: one thread dispatching, one
/// firing timers, one hot-reloading. Every rendered value must be delivered
/// exactly once, on the right channel.
#[test]
fn concurrent_dispatch_timers_and_reloads_deliver_each_patch_exactly_once() {
    const ROUNDS: usize = 150;
    let app = Arc::new(boot_app());
    let sub = app.runtime.subscribe().unwrap();
    let stop = Arc::new(AtomicBool::new(false));

    // Drain SSE as we go so the subscriber never overflows.
    let collector = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut pushed = Vec::new();
            while !stop.load(Ordering::SeqCst) {
                pushed.extend(sub.frames.try_iter().map(|f| f.to_string()));
                std::thread::yield_now();
            }
            pushed.extend(sub.frames.try_iter().map(|f| f.to_string()));
            pushed
        })
    };
    let dispatcher = {
        let app = Arc::clone(&app);
        std::thread::spawn(move || {
            (0..ROUNDS)
                .map(|_| text(&app.runtime.dispatch(&request("App:increment")).patches))
                .collect::<Vec<String>>()
        })
    };
    let timer = {
        let app = Arc::clone(&app);
        std::thread::spawn(move || {
            for _ in 0..ROUNDS {
                app.runtime.fire_timer("counter", "increment");
            }
        })
    };
    for i in 0..20 {
        app.edit("app.hypen", &app_ui(&format!("    Text(\"reload-{i}-end\")\n")));
    }
    let deltas = dispatcher.join().unwrap();
    timer.join().unwrap();
    stop.store(true, Ordering::SeqCst);
    let pushed = collector.join().unwrap().join("\n");
    let deltas = deltas.join("\n");

    for n in 1..=ROUNDS {
        // App scope: driven by dispatches → only ever in a dispatch response.
        let app_value = format!("\"App: {n}\"");
        assert_eq!(deltas.matches(&app_value).count(), 1, "{app_value} in dispatch deltas");
        assert_eq!(pushed.matches(&app_value).count(), 0, "{app_value} leaked to SSE");
        // Counter scope: driven by timers → only ever pushed.
        let counter_value = format!("\"Counter: {n}\"");
        assert_eq!(pushed.matches(&counter_value).count(), 1, "{counter_value} pushed");
        assert_eq!(deltas.matches(&counter_value).count(), 0, "{counter_value} leaked to a dispatch");
    }
    for i in 0..20 {
        let marker = format!("reload-{i}-end");
        assert_eq!(pushed.matches(&marker).count(), 1, "{marker} pushed once");
        assert_eq!(deltas.matches(&marker).count(), 0, "{marker} leaked to a dispatch");
    }
}

// ── hot reload (defect 6) ───────────────────────────────────────────────────

#[test]
fn a_template_edit_mints_a_usage_scope_and_wasm_reload_reaches_it() {
    let app = boot_app();
    assert_eq!(app.runtime.watch_paths().len(), 3, "a.wasm + two templates");

    let events = app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    assert!(
        events.iter().any(|e| matches!(e, ReloadEvent::ScopeMinted { scope, .. } if scope == "counter__a")),
        "{events:?}"
    );
    assert_eq!(app.count("counter__a"), 5);
    assert_eq!(app.host.instance_count(), 3);
    assert!(text(&app.runtime.tree_snapshot()).contains("Counter: 5"));

    // Give every scope some state, then rebuild the shared .wasm.
    for scope in ["App", "Counter", "counter__a"] {
        assert!(app.runtime.dispatch(&request(&format!("{scope}:increment"))).result.is_ok());
    }
    let events = app.edit("a.wasm", "v2");
    let reloaded: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ReloadEvent::ModuleReloaded { scope } => Some(scope.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reloaded, vec!["app", "counter", "counter__a"], "the live-minted scope reloads too");

    // State survived the swap, old instances were destroyed, and the new
    // bytes are live in every scope (v2 adds `reset`).
    assert_eq!((app.count("app"), app.count("counter"), app.count("counter__a")), (json!(1), json!(1), json!(6)));
    assert_eq!(app.host.instance_count(), 3, "one instance per scope after the swap");
    assert!(app.runtime.dispatch(&request("counter__a:reset")).result.is_ok());
    assert_eq!(app.count("counter__a"), 0);
    assert!(app.runtime.state_envelope()["actions"].as_array().unwrap().contains(&json!("reset")));
}

#[test]
fn a_failed_mint_leaks_no_instance_and_does_not_block_the_reload() {
    let app = boot_app();
    app.host.fail_init("counter__a", true);
    let events = app.edit("app.hypen", &app_ui("    Counter(start: 5)\n    Text(\"still-rendered\")\n"));
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReloadEvent::MintFailed { scope, error: RuntimeError::Module { stage: ModuleStage::Init, .. } }
                if scope == "counter__a"
        )),
        "{events:?}"
    );
    assert_eq!(app.host.instances_of("counter__a"), 0, "the half-started instance was destroyed");
    assert_eq!(app.host.instance_count(), 2);
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::Rerendered { .. })), "{events:?}");
    assert!(text(&app.runtime.tree_snapshot()).contains("still-rendered"));

    // Once the module can start, the next edit mints it.
    app.host.fail_init("counter__a", false);
    let events = app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::ScopeMinted { .. })), "{events:?}");
    assert_eq!(app.host.instance_count(), 3);
}

#[test]
fn a_reload_that_cannot_instantiate_keeps_the_old_instance() {
    let app = boot_app();
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    app.host.fail_instantiate("counter");
    let events = app.edit("a.wasm", "v2");
    assert!(
        events.iter().any(|e| matches!(e, ReloadEvent::ModuleReloadFailed { scope, .. } if scope == "counter")),
        "{events:?}"
    );
    assert_eq!(app.host.instance_count(), 2);
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 2);
}

#[test]
fn an_unreadable_or_unparseable_template_is_reported_and_survivable() {
    let app = boot_app();
    let events = app.edit("app.hypen", "module App {");
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::RerenderFailed { .. })), "{events:?}");
    // Fix it: the next edit renders again.
    let events = app.edit("app.hypen", &app_ui("    Text(\"fixed\")\n"));
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::Rerendered { .. })), "{events:?}");
    assert!(text(&app.runtime.tree_snapshot()).contains("fixed"));
    // Files nobody watches change nothing.
    assert!(app.runtime.files_changed(&[app.path("unrelated.txt")]).is_empty());
}

// ── crash recovery (defect 10) ──────────────────────────────────────────────

#[test]
fn a_crashed_module_fails_its_dispatch_then_restarts_on_the_next_action() {
    let app = boot_app();
    for _ in 0..3 {
        assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    }
    assert!(app.runtime.dispatch(&request("App:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 3);

    // The crashing dispatch names the module.
    let outcome = app.runtime.dispatch(&request("Counter:crash"));
    let err = outcome.result.expect_err("crash is an error");
    assert!(
        matches!(err, RuntimeError::ModuleCrashed { ref scopes, .. } if scopes == &["counter".to_string()]),
        "{err}"
    );
    assert!(crate::error::one_line(&err).contains("wasm trap"), "{}", crate::error::one_line(&err));
    assert!(err.hint().unwrap().contains("next action"));

    // The next action — even one for another scope — restarts it first, from
    // its original config: its state is gone, siblings are untouched.
    let outcome = app.runtime.dispatch(&request("App:increment"));
    assert!(outcome.result.is_ok(), "{:?}", outcome.result.err().map(|e| e.to_string()));
    assert_eq!(app.count("counter"), 0, "re-initialised");
    assert_eq!(app.count("app"), 2, "sibling state preserved");
    assert_eq!(app.host.instance_count(), 2, "the dead instance was destroyed");
    // The restart's re-render rides the dispatch that triggered it.
    assert!(text(&outcome.patches).contains("Counter: 0"), "{}", text(&outcome.patches));

    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 1);
}

#[test]
fn a_module_that_cannot_restart_stays_crashed_and_is_retried() {
    let app = boot_app();
    assert!(app.runtime.dispatch(&request("Counter:crash")).result.is_err());

    app.host.fail_init("counter", true);
    let outcome = app.runtime.dispatch(&request("Counter:increment"));
    assert!(
        matches!(outcome.result, Err(RuntimeError::ModuleCrashed { ref scopes, .. }) if scopes == &["counter".to_string()]),
        "{:?}",
        outcome.result.err().map(|e| e.to_string())
    );
    // Other modules keep working meanwhile.
    assert!(app.runtime.dispatch(&request("App:increment")).result.is_ok());
    assert_eq!(app.host.instances_of("counter"), 1, "failed restarts do not pile up instances");

    app.host.fail_init("counter", false);
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 1);
    assert_eq!(app.host.instance_count(), 2);
}

#[test]
fn a_timer_for_a_crashed_module_restarts_it_too() {
    let app = boot_app();
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert!(app.runtime.dispatch(&request("Counter:crash")).result.is_err());
    app.runtime.fire_timer("counter", "increment");
    assert_eq!(app.count("counter"), 1, "restarted at 0, then the timer's increment");
}

#[test]
fn hot_reloading_a_crashed_module_restarts_it_from_the_new_bytes() {
    let app = boot_app();
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert!(app.runtime.dispatch(&request("Counter:crash")).result.is_err());
    let events = app.edit("a.wasm", "v2");
    assert!(
        events.iter().any(|e| matches!(e, ReloadEvent::ModuleReloaded { scope } if scope == "counter")),
        "{events:?}"
    );
    assert_eq!(app.count("counter"), 0);
    assert!(app.runtime.dispatch(&request("Counter:reset")).result.is_ok());
    assert_eq!(app.host.instance_count(), 2);
}

/// A host that tracks instance health is simply asked: the crash is found
/// without any further guest call, and the host's reason is surfaced.
#[test]
fn a_crash_is_read_from_the_hosts_instance_status_without_probing_the_guest() {
    let app = boot_app();
    app.host.report_status();
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());

    let before = app.host.guest_calls();
    let outcome = app.runtime.dispatch(&request("Counter:crash"));
    assert_eq!(app.host.guest_calls() - before, 1, "the crashing dispatch and nothing else");
    let err = outcome.result.expect_err("crash is an error");
    match &err {
        RuntimeError::ModuleCrashed { scopes, reasons, .. } => {
            assert_eq!(scopes, &["counter"]);
            assert_eq!(reasons, &["fake: export `dispatch` trapped"]);
        }
        other => panic!("expected ModuleCrashed, got {other}"),
    }
    assert!(err.to_string().contains("crashed (fake: export `dispatch` trapped)"), "{err}");

    // A reducer error on a status-reporting host is still not a crash.
    let outcome = app.runtime.dispatch(&request("App:fail"));
    assert!(matches!(outcome.result, Err(RuntimeError::Dispatch(EngineError::ModuleError(_)))));
    assert_eq!(app.count("counter"), 0, "…and that action restarted the crashed module");
}

/// A host that answers `Unknown` is not probed either: the crash is read from
/// the engine's typed report of the failed dispatch.
#[test]
fn without_instance_status_the_crash_is_read_from_the_cascade_report() {
    let app = boot_app();
    let before = app.host.guest_calls();
    let err = app.runtime.dispatch(&request("Counter:crash")).result.expect_err("crash");
    assert_eq!(app.host.guest_calls() - before, 1, "no liveness probe");
    match &err {
        RuntimeError::ModuleCrashed { scopes, reasons, .. } => {
            assert_eq!(scopes, &["counter"]);
            assert_eq!(reasons, &["module trapped: wasm trap: unreachable"]);
        }
        other => panic!("expected ModuleCrashed, got {other}"),
    }

    // While it cannot restart, later failures still name it — with the
    // reason remembered from when it died.
    app.host.fail_init("counter", true);
    let err = app.runtime.dispatch(&request("App:fail")).result.expect_err("still crashed");
    assert!(
        matches!(err, RuntimeError::ModuleCrashed { ref scopes, ref reasons, .. }
            if scopes == &["counter"] && reasons == &["module trapped: wasm trap: unreachable"]),
        "{err}"
    );
}

// ── retiring usage scopes; re-seeding ───────────────────────────────────────

#[test]
fn a_usage_removed_by_a_template_edit_retires_its_instance() {
    let app = boot_app();
    app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    assert_eq!(app.host.instance_count(), 3);
    assert!(app.runtime.dispatch(&request("counter__a:increment")).result.is_ok());
    assert!(app.runtime.watch_paths().iter().all(|p| !p.ends_with("counter__a")));

    // Remove the usage again.
    let events = app.edit("app.hypen", &app_ui(""));
    let retired_at = events
        .iter()
        .position(|e| matches!(e, ReloadEvent::ScopeRetired { scope } if scope == "counter__a"))
        .unwrap_or_else(|| panic!("{events:?}"));
    let rendered_at = events
        .iter()
        .position(|e| matches!(e, ReloadEvent::Rerendered { .. }))
        .unwrap_or_else(|| panic!("{events:?}"));
    assert!(rendered_at < retired_at, "retired only once nothing rendered references it");

    assert_eq!(app.host.destroyed_hooks(), ["counter__a"], "on_destroyed ran, once");
    assert_eq!(app.host.instance_count(), 2, "the host instance is gone");
    assert_eq!(app.host.instances_of("counter__a"), 0);
    let envelope = app.runtime.state_envelope();
    assert!(envelope["states"].get("counter__a").is_none(), "{envelope}");
    assert!(!text(&app.runtime.tree_snapshot()).contains("Counter: 6"));

    // Nothing routes to it any more — a dispatch or a pending timer.
    let err = app.runtime.dispatch(&request("counter__a:increment")).result.expect_err("gone");
    assert!(matches!(err, RuntimeError::UnknownAction { .. }), "{err}");
    app.runtime.fire_timer("counter__a", "increment");
    // The modules that stayed are untouched.
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 1);

    // Bringing the usage back mints a fresh instance from its config.
    let events = app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::ScopeMinted { .. })), "{events:?}");
    assert_eq!(app.count("counter__a"), 5);
}

#[test]
fn a_scope_is_kept_while_the_edit_that_drops_it_does_not_render() {
    let app = boot_app();
    app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    assert!(app.runtime.dispatch(&request("counter__a:increment")).result.is_ok());

    // An edit that drops the usage but does not parse: the old tree (which
    // shows counter__a) is still on screen, so its instance stays.
    let events = app.edit("app.hypen", "module App {");
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::RerenderFailed { .. })), "{events:?}");
    assert!(
        !events.iter().any(|e| matches!(e, ReloadEvent::ScopeRetired { .. })),
        "{events:?}"
    );
    assert_eq!(app.host.instance_count(), 3);
    assert_eq!(app.count("counter__a"), 6);

    // The fixed edit renders, and then retires it.
    let events = app.edit("app.hypen", &app_ui(""));
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::ScopeRetired { .. })), "{events:?}");
    assert_eq!(app.host.instance_count(), 2);
}

#[test]
fn a_failing_on_destroyed_is_reported_and_the_scope_is_retired_anyway() {
    let app = boot_app();
    app.edit("app.hypen", &app_ui("    Counter(start: 5)\n"));
    app.host.fail_on_destroyed("counter__a");
    let events = app.edit("app.hypen", &app_ui(""));
    let error = events
        .iter()
        .find_map(|e| match e {
            ReloadEvent::ScopeRetiredWithError { scope, error } if scope == "counter__a" => {
                Some(crate::error::one_line(error))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("{events:?}"));
    assert!(error.contains("module `counter__a`: on_destroyed failed"), "{error}");
    assert!(error.contains("on_destroyed refused"), "{error}");
    assert_eq!(app.host.instance_count(), 2, "torn down regardless");
    assert!(app.runtime.state_envelope()["states"].get("counter__a").is_none());

    // A crashed usage scope retires cleanly too (its hook cannot run).
    app.edit("app.hypen", &app_ui("    Counter(start: 7)\n"));
    assert!(app.runtime.dispatch(&request("counter__a:crash")).result.is_err());
    let events = app.edit("app.hypen", &app_ui(""));
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReloadEvent::ScopeRetired { .. } | ReloadEvent::ScopeRetiredWithError { .. }
        )),
        "{events:?}"
    );
    assert_eq!(app.host.instance_count(), 2);
    assert!(app.runtime.dispatch(&request("App:increment")).result.is_ok(), "nothing left crashed");
}

/// Single-module mode: boot `ui` over one fake module.
fn boot_single(ui: &str) -> (tempfile::TempDir, FakeHandle, Runtime) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("m.wasm"), b"v1").unwrap();
    std::fs::write(dir.path().join("ui.hypen"), ui).unwrap();
    let source = Source::Module(ModuleSource {
        wasm: dir.path().join("m.wasm"),
        scope: ScopeName::new("seeded").unwrap(),
        ui: Some(dir.path().join("ui.hypen")),
        actions: ActionSource::Discover,
        grants: Grants::default(),
    });
    let (host, handle) = fake_host();
    let booted = Runtime::boot_with_host(&source, host).unwrap();
    (dir, handle, booted.runtime)
}

#[test]
fn a_ui_edit_that_changes_the_declaration_config_reseeds_the_single_module() {
    let (dir, host, runtime) = boot_single("module seeded(start: 7) { Text(\"N: @{state.count}\") }");
    let ui = std::fs::canonicalize(dir.path()).unwrap().join("ui.hypen");
    let edit = |contents: &str| {
        std::fs::write(&ui, contents).unwrap();
        runtime.files_changed(std::slice::from_ref(&ui))
    };
    assert!(runtime.dispatch(&request("increment")).result.is_ok());
    assert_eq!(runtime.module_state("seeded"), json!({ "count": 8 }));

    // Same config, different markup: the instance and its state stay.
    let events = edit("module seeded(start: 7) { Text(\"Now: @{state.count}\") }");
    assert!(!events.iter().any(|e| matches!(e, ReloadEvent::ModuleReseeded { .. })), "{events:?}");
    assert_eq!(runtime.module_state("seeded"), json!({ "count": 8 }));
    assert!(text(&runtime.tree_snapshot()).contains("Now: 8"));

    // A new config re-runs init with it, on a fresh instance.
    let events = edit("module seeded(start: 40) { Text(\"Now: @{state.count}\") }");
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReloadEvent::ModuleReseeded { scope, config } if scope == "seeded" && config == &json!({ "start": 40 })
        )),
        "{events:?}"
    );
    assert_eq!(runtime.module_state("seeded"), json!({ "count": 40 }));
    assert_eq!(host.instance_count(), 1, "the old instance was destroyed");
    assert!(text(&runtime.tree_snapshot()).contains("Now: 40"));
    assert!(runtime.dispatch(&request("increment")).result.is_ok());

    // If the module cannot start with the new config it keeps running with
    // the old one, and the next edit tries again.
    host.fail_init("seeded", true);
    let events = edit("module seeded(start: 50) { Text(\"Now: @{state.count}\") }");
    assert!(
        events.iter().any(|e| matches!(e, ReloadEvent::ModuleReseedFailed { scope, .. } if scope == "seeded")),
        "{events:?}"
    );
    assert_eq!(runtime.module_state("seeded"), json!({ "count": 41 }));
    assert_eq!(host.instance_count(), 1);
    host.fail_init("seeded", false);
    let events = edit("module seeded(start: 50) { Text(\"Again: @{state.count}\") }");
    assert!(events.iter().any(|e| matches!(e, ReloadEvent::ModuleReseeded { .. })), "{events:?}");
    assert_eq!(runtime.module_state("seeded"), json!({ "count": 50 }));
}

#[test]
fn a_wasm_that_cannot_be_read_fails_the_reload_of_each_of_its_scopes() {
    let app = boot_app();
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    let wasm = app.path("a.wasm");
    std::fs::remove_file(&wasm).unwrap();
    let events = app.runtime.files_changed(std::slice::from_ref(&wasm));
    let failed: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ReloadEvent::ModuleReloadFailed { scope, error: RuntimeError::Io { action: "read", .. } } => {
                Some(scope.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(failed, ["app", "counter"], "{events:?}");
    // The running instances are untouched.
    assert_eq!(app.host.registered("counter").as_deref(), Some(&b"v1"[..]));
    assert!(app.runtime.dispatch(&request("Counter:increment")).result.is_ok());
    assert_eq!(app.count("counter"), 2);
}

#[test]
fn watching_covers_the_directories_of_every_module_and_template() {
    let app = boot_app();
    let root = std::fs::canonicalize(app.dir.path()).unwrap();
    assert_eq!(app.runtime.watch_dirs(), vec![root], "one directory holds all three files");
}

// ── requests ────────────────────────────────────────────────────────────────

#[test]
fn action_names_parse_into_targets() {
    let r = DispatchRequest::new("increment", Value::Null, None);
    assert_eq!(r.target, ActionTarget::Named);
    assert_eq!(r.addressed_scope(), None);

    let r = DispatchRequest::new("Counter:increment", Value::Null, None);
    assert_eq!(r.addressed_scope(), Some("counter"));

    // Engine wire names keep their colons.
    for name in ["__hypen_scoped:counter:increment", "__hypen_dispatch", ":x"] {
        assert_eq!(DispatchRequest::new(name, Value::Null, None).target, ActionTarget::Named, "{name}");
    }
}
