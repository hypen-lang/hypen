//! Theme: the cross-SDK resolution fixture, and the engine integration —
//! `@theme.*` in templates, sparse re-render on a scheme switch, scheme
//! switches made from inside action handlers, per-session forks.

use std::path::Path;
use std::sync::{Arc, Mutex};

use hypen_server::device::{DeviceTransport, SessionTransport};
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Empty {}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Counter {
    count: i32,
}

const UI: &str = r#"Column {
    Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
    Text("@{theme.font.body} / @{appearance.scheme}")
}.backgroundColor(@theme.color.surface)"#;

fn make_theme() -> Theme {
    Theme::builder()
        .tokens(json!({
            "color": {
                "brand": "#0066ff",
                "primary": "{color.brand}",
                "surface": "#ffffff",
                "ink": "#111111"
            },
            "space": { "md": 16 },
            "font": { "body": "Inter" }
        }))
        .schemes(json!({
            "dark": { "color": { "brand": "#66a3ff", "surface": "#111111", "ink": "#f5f5f5" } },
            "sepia": { "color": { "surface": "#f4ecd8", "ink": "#3b2f1e" } }
        }))
        .build()
}

/// Patches as their wire JSON.
type Wire = Arc<Mutex<Vec<Value>>>;

fn capture<S: State>(instance: &ModuleInstance<S>) -> (Wire, Arc<Mutex<usize>>) {
    let patches: Wire = Arc::default();
    let batches = Arc::new(Mutex::new(0usize));
    let (sink, count) = (Arc::clone(&patches), Arc::clone(&batches));
    instance.on_patches(move |batch| {
        *count.lock().unwrap() += 1;
        sink.lock()
            .unwrap()
            .extend(batch.iter().map(|p| serde_json::to_value(p).unwrap()));
    });
    (patches, batches)
}

/// Every prop a batch sets, from `create` and `setProp` alike, as `(name, value)`.
fn props(patches: &[Value]) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for patch in patches {
        match patch["type"].as_str() {
            Some("create") => {
                for (name, value) in patch["props"].as_object().unwrap() {
                    out.push((name.clone(), value.clone()));
                }
            }
            Some("setProp") => out.push((
                patch["name"].as_str().unwrap().to_string(),
                patch["value"].clone(),
            )),
            _ => {}
        }
    }
    out
}

fn has_prop(patches: &[Value], name: &str, value: Value) -> bool {
    props(patches).contains(&(name.to_string(), value))
}

fn sorted(mut props: Vec<(String, Value)>) -> Vec<(String, Value)> {
    props.sort_by(|a, b| a.0.cmp(&b.0));
    props
}

// ---------------------------------------------------------------------------
// Cross-SDK fixture
// ---------------------------------------------------------------------------

#[test]
fn cross_sdk_resolution_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/theme/resolve.json");
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().unwrap();
        let system = match case["system"].as_str().unwrap() {
            "dark" => SystemScheme::Dark,
            "light" => SystemScheme::Light,
            other => panic!("{name}: unknown system scheme {other}"),
        };
        let theme = Theme::builder()
            .tokens(case["tokens"].clone())
            .schemes(case["schemes"].clone())
            .scheme(case["preference"].as_str().unwrap())
            .system_scheme(system)
            .build();
        let expected = &case["expected"];
        assert_eq!(
            theme.scheme(),
            expected["scheme"].as_str().unwrap(),
            "{name}: scheme"
        );
        assert_eq!(theme.tokens(), expected["tokens"], "{name}: tokens");
        assert_eq!(
            theme.problems().len() as u64,
            expected["problems"].as_u64().unwrap(),
            "{name}: problems {:?}",
            theme.problems()
        );

        // The same answer when the scheme is reached by switching to it.
        let switched = Theme::builder()
            .tokens(case["tokens"].clone())
            .schemes(case["schemes"].clone())
            .build();
        switched.set_system_scheme(system);
        switched
            .set_scheme(case["preference"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            switched.tokens(),
            expected["tokens"],
            "{name}: tokens after switching"
        );
    }
}

// ---------------------------------------------------------------------------
// Engine integration (in-process ModuleInstance)
// ---------------------------------------------------------------------------

#[test]
fn tokens_resolve_in_applicators_and_templates() {
    let theme = make_theme();
    let def = HypenApp::module::<Empty>("App")
        .state(Empty {})
        .ui(UI)
        .build();
    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.attach_theme(&theme);
    let (patches, _) = capture(&instance);
    instance.mount();

    let patches = patches.lock().unwrap();
    assert!(
        has_prop(&patches, "color.0", json!("#0066ff")),
        "{patches:#?}"
    );
    assert!(has_prop(&patches, "padding.0", json!(16)));
    assert!(has_prop(&patches, "backgroundColor.0", json!("#ffffff")));
    assert!(has_prop(&patches, "0", json!("Inter / light")));
}

#[test]
fn a_scheme_switch_emits_only_the_changed_props() {
    let theme = make_theme();
    let def = HypenApp::module::<Empty>("App")
        .state(Empty {})
        .ui(r#"Column {
            Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
            Text("@{theme.font.body}")
        }.backgroundColor(@theme.color.surface)"#)
        .build();
    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.attach_theme(&theme);
    let (patches, _) = capture(&instance);
    instance.mount();
    patches.lock().unwrap().clear();

    theme.set_scheme("dark").unwrap();
    {
        let patches = patches.lock().unwrap();
        assert!(
            patches.iter().all(|p| p["type"] == "setProp"),
            "only setProp expected: {patches:#?}"
        );
        assert_eq!(
            sorted(props(&patches)),
            vec![
                ("backgroundColor.0".to_string(), json!("#111111")),
                ("color.0".to_string(), json!("#66a3ff")),
            ]
        );
    }

    // The preference is explicit: a system report changes nothing on screen.
    patches.lock().unwrap().clear();
    theme.set_system_scheme(SystemScheme::Dark);
    assert!(patches.lock().unwrap().is_empty());
}

#[test]
fn a_handler_can_switch_scheme_mid_dispatch() {
    let theme = make_theme();
    let ctx = Arc::new(GlobalContext::new());
    ctx.set_theme(theme.clone());
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen_in_handler = Arc::clone(&seen);
    let def = HypenApp::module::<Counter>("App")
        .state(Counter { count: 0 })
        .ui(r#"Text("n @{state.count}").color(@theme.color.ink)"#)
        .on_action::<()>("go", move |state, _, ctx| {
            // The engine is mid-dispatch here; both switches must be
            // deferred, and only the last one rendered.
            let theme = ctx.unwrap().theme().expect("theme on the context");
            theme.set_scheme("sepia").unwrap();
            theme.set_scheme("dark").unwrap();
            state.count += 1;
            seen_in_handler
                .lock()
                .unwrap()
                .extend([json!(theme.scheme()), theme.token("color.ink").unwrap()]);
        })
        .build();
    // Created with the context: the theme is attached without further calls.
    let instance = ModuleInstance::new(Arc::new(def), Some(ctx)).unwrap();
    let (patches, _) = capture(&instance);
    instance.mount();
    assert!(has_prop(
        &patches.lock().unwrap(),
        "color.0",
        json!("#111111")
    ));
    patches.lock().unwrap().clear();

    instance.dispatch_action("go", None).unwrap();

    // The handler saw its own change at once …
    assert_eq!(*seen.lock().unwrap(), vec![json!("dark"), json!("#f5f5f5")]);
    // … and the engine rendered the final token once, plus the state change.
    let patches = patches.lock().unwrap();
    assert!(
        patches.iter().all(|p| p["type"] == "setProp"),
        "{patches:#?}"
    );
    assert_eq!(
        sorted(props(&patches)),
        vec![
            ("0".to_string(), json!("n 1")),
            ("color.0".to_string(), json!("#f5f5f5")),
        ]
    );
}

#[test]
fn app_theme_reaches_instances_and_handlers() {
    let theme = make_theme();
    let app = HypenApp::builder().theme(theme.clone()).build();
    let def = HypenApp::module::<Empty>("App")
        .state(Empty {})
        .ui(r#"Text("x").color(@theme.color.surface)"#)
        .on_action::<()>("toggle", |_, _, ctx| ctx.unwrap().theme().unwrap().toggle())
        .build();
    let instance = app.instantiate(Arc::new(def)).unwrap();
    let (patches, batches) = capture(&instance);
    instance.mount();
    assert!(has_prop(
        &patches.lock().unwrap(),
        "color.0",
        json!("#ffffff")
    ));
    patches.lock().unwrap().clear();
    *batches.lock().unwrap() = 0;

    instance.dispatch_action("toggle", None).unwrap();
    assert_eq!(theme.scheme(), "dark");
    assert_eq!(
        props(&patches.lock().unwrap()),
        vec![("color.0".to_string(), json!("#111111"))]
    );
    assert_eq!(*batches.lock().unwrap(), 1);
}

#[test]
fn set_context_exposes_any_data_source() {
    let def = HypenApp::module::<Empty>("App")
        .state(Empty {})
        .ui(r#"Text("@{weather.city}")"#)
        .build();
    let instance = ModuleInstance::new(Arc::new(def), None).unwrap();
    instance.set_context("weather", json!({ "city": "Oslo", "temp": 3 }));
    let (patches, _) = capture(&instance);
    instance.mount();
    assert!(has_prop(&patches.lock().unwrap(), "0", json!("Oslo")));
    patches.lock().unwrap().clear();

    instance.set_context("weather", json!({ "city": "Oslo", "temp": 4 }));
    assert!(patches.lock().unwrap().is_empty(), "nothing bound to temp");
    instance.set_context("weather", json!({ "city": "Bergen", "temp": 4 }));
    assert_eq!(
        props(&patches.lock().unwrap()),
        vec![("0".to_string(), json!("Bergen"))]
    );
}

#[test]
fn a_detached_or_dropped_engine_is_no_longer_published_to() {
    let theme = make_theme();
    let def = Arc::new(
        HypenApp::module::<Empty>("App")
            .state(Empty {})
            .ui(r#"Text("x").color(@theme.color.surface)"#)
            .build(),
    );
    let instance = ModuleInstance::new(Arc::clone(&def), None).unwrap();
    let attachment = instance.attach_theme(&theme);
    let (patches, _) = capture(&instance);
    instance.mount();
    patches.lock().unwrap().clear();

    attachment.detach();
    theme.set_scheme("dark").unwrap();
    assert!(patches.lock().unwrap().is_empty());

    // A dropped instance's sink is inert (and pruned): no panic, no leak of
    // the engine through the theme.
    let gone = ModuleInstance::new(def, None).unwrap();
    gone.attach_theme(&theme);
    drop(gone);
    theme.set_scheme("light").unwrap();
}

// ---------------------------------------------------------------------------
// RemoteSession
// ---------------------------------------------------------------------------

fn session_def() -> Arc<ModuleDefinition<Counter>> {
    Arc::new(
        HypenApp::module::<Counter>("App")
            .state(Counter { count: 0 })
            .ui(r#"Column {
                Text("n @{state.count}").color(@theme.color.ink)
                Text("@{appearance.scheme}")
            }"#)
            .on_action::<()>("toggle", |state, _, ctx| {
                ctx.unwrap().theme().unwrap().toggle();
                state.count += 1;
            })
            .on_action::<()>("bump", |state, _, _| state.count += 1)
            .on_action::<()>("pinLight", |_, _, ctx| {
                ctx.unwrap().theme().unwrap().set_scheme("light").unwrap()
            })
            .build(),
    )
}

fn patches_of(messages: &[String], kind: &str) -> Vec<Value> {
    messages
        .iter()
        .map(|m| serde_json::from_str::<Value>(m).unwrap())
        .filter(|m| m["type"] == kind)
        .flat_map(|m| m["patches"].as_array().cloned().unwrap_or_default())
        .collect()
}

fn dispatch(action: &str) -> String {
    json!({ "type": "dispatchAction", "module": "App", "action": action }).to_string()
}

#[test]
fn each_session_forks_the_theme() {
    let theme = make_theme();
    let a =
        RemoteSession::from_definition(session_def(), ComponentRegistry::new()).with_theme(&theme);
    let b =
        RemoteSession::from_definition(session_def(), ComponentRegistry::new()).with_theme(&theme);

    // Published before the first render.
    for session in [&a, &b] {
        let tree = patches_of(&session.handle_hello(None), "initialTree");
        assert!(has_prop(&tree, "color.0", json!("#111111")), "{tree:#?}");
        assert!(has_prop(&tree, "0", json!("light")));
    }

    // A handler in session A switches scheme mid-dispatch: one patch
    // message carries the token, the appearance and the state change.
    let replies = a.handle_message(&dispatch("toggle"));
    assert_eq!(replies.len(), 1, "{replies:#?}");
    let patches = patches_of(&replies, "patch");
    assert!(
        patches.iter().all(|p| p["type"] == "setProp"),
        "{patches:#?}"
    );
    assert_eq!(
        sorted(props(&patches)),
        sorted(vec![
            ("0".to_string(), json!("n 1")),
            ("0".to_string(), json!("dark")),
            ("color.0".to_string(), json!("#f5f5f5")),
        ])
    );
    assert_eq!(a.theme().unwrap().scheme(), "dark");

    // Session B and the app's own theme are untouched.
    assert_eq!(b.theme().unwrap().scheme(), "light");
    assert_eq!(theme.scheme(), "light");
    let patches = patches_of(&b.handle_message(&dispatch("bump")), "patch");
    assert_eq!(props(&patches), vec![("0".to_string(), json!("n 1"))]);
}

#[test]
fn an_in_process_session_flushes_host_side_changes_on_request() {
    let theme = make_theme();
    let session =
        RemoteSession::from_definition(session_def(), ComponentRegistry::new()).with_theme(&theme);
    session.handle_hello(None);
    assert!(session.flush_contexts().is_empty());

    // The host forwards the client's system scheme, outside any handler.
    session
        .theme()
        .unwrap()
        .set_system_scheme(SystemScheme::Dark);
    let messages = session.flush_contexts();
    assert_eq!(messages.len(), 1);
    let message: Value = serde_json::from_str(&messages[0]).unwrap();
    assert_eq!(message["revision"], 1);
    assert_eq!(
        sorted(props(&patches_of(&messages, "patch"))),
        sorted(vec![
            ("0".to_string(), json!("dark")),
            ("color.0".to_string(), json!("#f5f5f5")),
        ])
    );
    assert!(session.flush_contexts().is_empty());

    // Left queued, it rides the next dispatch instead.
    session.theme().unwrap().set_scheme("sepia").unwrap();
    let patches = patches_of(&session.handle_message(&dispatch("bump")), "patch");
    assert!(
        has_prop(&patches, "color.0", json!("#3b2f1e")),
        "{patches:#?}"
    );
    assert!(has_prop(&patches, "0", json!("n 1")));
}

#[derive(Default)]
struct RecordingTransport(Mutex<Vec<String>>);

impl DeviceTransport for RecordingTransport {
    fn send_text(&self, _text: String) {}
    fn send_binary(&self, _frame: Vec<u8>) {}
    fn close(&self, _code: u16, _reason: &str) {}
    fn buffered_bytes(&self) -> usize {
        0
    }
}

impl SessionTransport for RecordingTransport {
    fn send_ui(&self, message: String) {
        self.0.lock().unwrap().push(message);
    }
}

#[test]
fn a_connected_session_ships_host_side_changes_through_its_transport() {
    let theme = make_theme();
    let transport = Arc::new(RecordingTransport::default());
    let session =
        RemoteSession::connect(session_def(), ComponentRegistry::new(), transport.clone())
            .with_theme(&theme);
    session.handle_hello(None);
    assert!(transport.0.lock().unwrap().is_empty());

    session.theme().unwrap().set_scheme("dark").unwrap();
    let sent = transport.0.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "{sent:#?}");
    assert!(has_prop(
        &patches_of(&sent, "patch"),
        "color.0",
        json!("#f5f5f5")
    ));

    // From a handler the patches are a reply, not a transport push.
    let replies = session.handle_message(&dispatch("toggle"));
    assert!(has_prop(
        &patches_of(&replies, "patch"),
        "color.0",
        json!("#111111")
    ));
    assert_eq!(transport.0.lock().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Client-reported system color scheme (hello.colorScheme, `colorScheme`)
// ---------------------------------------------------------------------------

fn themed_session(theme: &Theme) -> RemoteSession {
    RemoteSession::from_definition(session_def(), ComponentRegistry::new()).with_theme(theme)
}

fn hello(color_scheme: Value) -> String {
    json!({ "type": "hello", "colorScheme": color_scheme }).to_string()
}

fn color_scheme(scheme: Value) -> String {
    json!({ "type": "colorScheme", "scheme": scheme }).to_string()
}

#[test]
fn hello_color_scheme_seeds_the_first_frame() {
    let theme = make_theme();
    let session = themed_session(&theme);
    let replies = session.handle_message(&hello(json!("dark")));

    // sessionAck + initialTree, and nothing after: no light-then-dark flip.
    assert_eq!(replies.len(), 2, "{replies:#?}");
    assert!(patches_of(&replies, "patch").is_empty());
    let tree = patches_of(&replies, "initialTree");
    assert!(has_prop(&tree, "color.0", json!("#f5f5f5")), "{tree:#?}");
    assert!(has_prop(&tree, "0", json!("dark")));
    assert!(!has_prop(&tree, "color.0", json!("#111111")));
    assert_eq!(session.theme().unwrap().system_scheme(), SystemScheme::Dark);
    assert_eq!(session.theme_preference().as_deref(), Some("system"));
    // The app's own theme is not the session's.
    assert_eq!(theme.system_scheme(), SystemScheme::Light);
}

#[test]
fn malformed_hello_color_scheme_is_ignored() {
    for bad in [
        json!("blue"),
        json!(42),
        json!(null),
        json!(["dark"]),
        json!("Dark"),
    ] {
        let theme = make_theme();
        let session = themed_session(&theme);
        let replies = session.handle_message(&hello(bad.clone()));
        assert_eq!(replies.len(), 2, "{bad}: still a hello");
        let tree = patches_of(&replies, "initialTree");
        assert!(
            has_prop(&tree, "color.0", json!("#111111")),
            "{bad}: {tree:#?}"
        );
        assert_eq!(
            session.theme().unwrap().system_scheme(),
            SystemScheme::Light
        );
    }
}

#[test]
fn color_scheme_message_rerenders_only_what_changed() {
    let theme = make_theme();
    let session = themed_session(&theme);
    let other = themed_session(&theme);
    session.handle_message(&hello(json!("light")));
    other.handle_hello(None);

    let replies = session.handle_message(&color_scheme(json!("dark")));
    assert_eq!(replies.len(), 1, "{replies:#?}");
    let message: Value = serde_json::from_str(&replies[0]).unwrap();
    assert_eq!(message["type"], "patch");
    assert_eq!(message["revision"], 1);
    let patches = patches_of(&replies, "patch");
    assert!(
        patches.iter().all(|p| p["type"] == "setProp"),
        "{patches:#?}"
    );
    // The ink token and the scheme label; the counter text is untouched.
    assert_eq!(
        sorted(props(&patches)),
        sorted(vec![
            ("0".to_string(), json!("dark")),
            ("color.0".to_string(), json!("#f5f5f5")),
        ])
    );
    // Nothing was left queued, and a repeat changes nothing.
    assert!(session.flush_contexts().is_empty());
    assert!(session
        .handle_message(&color_scheme(json!("dark")))
        .is_empty());
    assert_eq!(session.revision(), 1);

    // A second session is unaffected.
    assert_eq!(other.theme().unwrap().scheme(), "light");
    assert!(other.flush_contexts().is_empty());
    let patches = patches_of(&other.handle_message(&dispatch("bump")), "patch");
    assert_eq!(props(&patches), vec![("0".to_string(), json!("n 1"))]);
}

#[test]
fn an_explicit_scheme_makes_color_scheme_messages_no_ops() {
    let theme = make_theme();
    let session = themed_session(&theme);
    session.handle_message(&hello(json!("dark")));

    // A handler pins the scheme.
    let patches = patches_of(&session.handle_message(&dispatch("pinLight")), "patch");
    assert!(
        has_prop(&patches, "color.0", json!("#111111")),
        "{patches:#?}"
    );
    let revision = session.revision();

    // Reports are remembered, not rendered.
    assert!(session
        .handle_message(&color_scheme(json!("light")))
        .is_empty());
    assert!(session
        .handle_message(&color_scheme(json!("dark")))
        .is_empty());
    assert!(session.flush_contexts().is_empty());
    assert_eq!(session.revision(), revision);
    let theme = session.theme().unwrap();
    assert_eq!(theme.scheme(), "light");
    assert_eq!(theme.system_scheme(), SystemScheme::Dark);

    // … until the session follows the system again.
    theme.set_scheme("system").unwrap();
    assert_eq!(theme.scheme(), "dark");
}

#[test]
fn malformed_early_or_themeless_color_scheme_messages_are_ignored() {
    let theme = make_theme();
    let session = themed_session(&theme);

    // Before the hello.
    assert!(session
        .handle_message(&color_scheme(json!("dark")))
        .is_empty());
    assert_eq!(
        session.theme().unwrap().system_scheme(),
        SystemScheme::Light
    );
    let tree = patches_of(&session.handle_hello(None), "initialTree");
    assert!(has_prop(&tree, "color.0", json!("#111111")));

    // Malformed.
    for bad in [
        color_scheme(json!("blue")),
        color_scheme(json!(1)),
        color_scheme(json!(null)),
        json!({ "type": "colorScheme" }).to_string(),
        json!({ "type": "colorScheme", "scheme": { "v": "dark" } }).to_string(),
    ] {
        assert!(session.handle_message(&bad).is_empty(), "{bad}");
    }
    assert_eq!(
        session.theme().unwrap().system_scheme(),
        SystemScheme::Light
    );
    assert_eq!(session.revision(), 0);
    // Other unknown messages are still ignored.
    assert!(session
        .handle_message(r#"{"type":"somethingElse","scheme":"dark"}"#)
        .is_empty());

    // No theme registered: nothing to tell.
    let plain = RemoteSession::from_definition(session_def(), ComponentRegistry::new());
    assert_eq!(plain.handle_message(&hello(json!("dark"))).len(), 2);
    assert!(plain
        .handle_message(&color_scheme(json!("dark")))
        .is_empty());
    assert!(plain.theme().is_none() && plain.theme_preference().is_none());
}

#[test]
fn a_connected_session_answers_color_scheme_as_a_reply() {
    let theme = make_theme();
    let transport = Arc::new(RecordingTransport::default());
    let session =
        RemoteSession::connect(session_def(), ComponentRegistry::new(), transport.clone())
            .with_theme(&theme);
    session.handle_message(&hello(json!("light")));

    let replies = session.handle_message(&color_scheme(json!("dark")));
    assert!(has_prop(
        &patches_of(&replies, "patch"),
        "color.0",
        json!("#f5f5f5")
    ));
    assert!(transport.0.lock().unwrap().is_empty(), "not pushed twice");
}

#[test]
fn color_scheme_wire_shapes() {
    let message = ColorSchemeMessage::new(SystemScheme::Dark);
    let wire: Value = serde_json::from_str(&message.to_json()).unwrap();
    assert_eq!(wire, json!({ "type": "colorScheme", "scheme": "dark" }));
    assert_eq!(
        ColorSchemeMessage::from_json(&message.to_json()),
        Some(message)
    );
    assert_eq!(ColorSchemeMessage::from_json(&hello(json!("dark"))), None);
    assert_eq!(
        ColorSchemeMessage::from_hello(&hello(json!("light"))),
        Some(SystemScheme::Light)
    );
    assert_eq!(ColorSchemeMessage::from_hello(r#"{"type":"hello"}"#), None);
    // The hello stays decodable as a RemoteMessage with the extra member.
    assert!(matches!(
        RemoteMessage::from_json(&hello(json!("dark"))),
        Ok(RemoteMessage::Hello { .. })
    ));
}

// ---------------------------------------------------------------------------
// Scheme preference across suspend / resume
// ---------------------------------------------------------------------------

#[test]
fn a_resumed_session_keeps_its_scheme_preference() {
    use hypen_server::remote::SessionManagerConfig;

    let theme = make_theme();
    let manager = SessionManager::new(SessionManagerConfig::default());
    let info = manager.create_session(Default::default());

    // First connection: the user picks sepia, then goes away.
    let first = themed_session(&theme);
    first.handle_message(&hello(json!("dark")));
    first.theme().unwrap().set_scheme("sepia").unwrap();
    assert!(manager.suspend_session_with_theme(
        &info.id,
        first.get_state(),
        first.theme_preference(),
        || {},
    ));
    drop(first);

    // Resume: the host rebuilds the session with the saved preference.
    let pending = manager.resume_session(&info.id).expect("still pending");
    assert_eq!(pending.theme_preference.as_deref(), Some("sepia"));
    let resumed = RemoteSession::from_definition(session_def(), ComponentRegistry::new())
        .with_theme_preference(&theme, pending.theme_preference.as_deref());
    let replies = resumed.handle_message(&hello(json!("dark")));
    let tree = patches_of(&replies, "initialTree");
    assert!(has_prop(&tree, "color.0", json!("#3b2f1e")), "{tree:#?}");
    assert!(has_prop(&tree, "0", json!("sepia")));
    assert_eq!(resumed.theme_preference().as_deref(), Some("sepia"));
    // The app theme and fresh sessions keep the default.
    assert_eq!(theme.preference(), "system");
    assert_eq!(
        themed_session(&theme).theme_preference().as_deref(),
        Some("system")
    );

    // A plain suspend carries none, and an unknown saved name follows the system.
    assert!(manager.suspend_session(&info.id, json!({}), || {}));
    assert_eq!(
        manager.resume_session(&info.id).unwrap().theme_preference,
        None
    );
    let odd = RemoteSession::from_definition(session_def(), ComponentRegistry::new())
        .with_theme_preference(&theme, Some("neon"));
    assert_eq!(odd.theme_preference().as_deref(), Some("system"));
}

#[test]
fn an_expired_suspension_drops_the_preference() {
    use hypen_server::remote::SessionManagerConfig;
    use std::time::Duration;

    // Leaked: the manager's TTL timer thread refers to it after the test body.
    let manager: &'static SessionManager =
        Box::leak(Box::new(SessionManager::new(SessionManagerConfig {
            ttl: Duration::from_millis(20),
            generate_id: None,
        })));
    let info = manager.create_session(Default::default());
    let expired = Arc::new(Mutex::new(false));
    let flag = Arc::clone(&expired);
    assert!(manager.suspend_session_with_theme(
        &info.id,
        json!({}),
        Some("dark".to_string()),
        move || *flag.lock().unwrap() = true,
    ));
    for _ in 0..200 {
        if *expired.lock().unwrap() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(*expired.lock().unwrap(), "TTL elapsed");
    assert!(manager.resume_session(&info.id).is_none());
}
