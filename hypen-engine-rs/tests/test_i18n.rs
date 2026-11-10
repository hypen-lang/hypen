//! i18n through the full pipeline: the reserved `t` provider, the `fmt()` /
//! `plural()` builtins, dependency tracking of provider refs used as function
//! arguments (so a locale switch re-renders them), and missing-key fallback.

mod common;

use common::*;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reactive::extract_bindings_from_expression;
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use serde_json::{json, Value};

/// English-like plural table (see `reactive::i18n::plural_category`).
fn en_rules() -> String {
    (0..201).map(|n| if n == 1 { 'o' } else { 'x' }).collect()
}

/// Croatian integer rules.
fn hr_rules() -> String {
    let cat = |n: u64| {
        let (m10, m100) = (n % 10, n % 100);
        if m10 == 1 && m100 != 11 {
            'o'
        } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
            'f'
        } else {
            'x'
        }
    };
    let mut s: String = (0..200).map(cat).collect();
    s.push(cat(1_000_000));
    s
}

fn en_catalog() -> Value {
    json!({
        "cart": { "title": "Cart" },
        "greeting": "Hello, {0}!",
        "items": { "one": "{count} item", "other": "{count} items", "__plural": en_rules() }
    })
}

fn hr_catalog() -> Value {
    json!({
        "cart": { "title": "Košarica" },
        "greeting": "Bok, {0}!",
        "items": {
            "one": "{count} stavka", "few": "{count} stavke", "other": "{count} stavki",
            "__plural": hr_rules()
        }
    })
}

fn render(engine: &mut Engine, source: &str) {
    let component = hypen_parser::parse_component(source).expect("parse");
    let ir = hypen_engine::ir::ast_to_ir_node(&component);
    engine.render_ir_node(&ir);
}

/// Every string value carried by Create / SetProp patches.
fn strings(patches: &[Patch]) -> Vec<String> {
    let mut out = Vec::new();
    for p in patches {
        match p {
            Patch::Create { props, .. } => out.extend(
                props
                    .values()
                    .filter_map(|v| v.as_str().map(str::to_string)),
            ),
            Patch::SetProp { value, .. } => {
                if let Some(s) = value.as_str() {
                    out.push(s.to_string())
                }
            }
            _ => {}
        }
    }
    out
}

fn engine_with(state: Value) -> Engine {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("Page"), state));
    engine
}

#[test]
fn provider_refs_as_function_arguments_are_dependencies() {
    let deps: Vec<String> = extract_bindings_from_expression("fmt(t.greeting, state.user.name)")
        .iter()
        .map(|b| b.full_path_with_source())
        .collect();
    assert!(deps.contains(&"t.greeting".to_string()), "{deps:?}");
    assert!(deps.contains(&"state.user.name".to_string()), "{deps:?}");

    let deps: Vec<String> = extract_bindings_from_expression("plural(state.count, t.cart.items)")
        .iter()
        .map(|b| b.full_path_with_source())
        .collect();
    assert!(deps.contains(&"t.cart.items".to_string()), "{deps:?}");
    assert!(deps.contains(&"state.count".to_string()), "{deps:?}");
}

#[test]
fn locale_switch_rerenders_plain_fmt_and_plural_nodes() {
    let mut engine = engine_with(json!({ "user": { "name": "Ana" }, "count": 3 }));
    engine.set_context("t", en_catalog());

    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Column {
            Text(@t.cart.title)
            Text("@{t.cart.title}")
            Text("@{fmt(t.greeting, state.user.name)}")
            Text("@{plural(state.count, t.items)}")
        }"#,
    );
    let initial = strings(&patches.lock().unwrap());
    for expected in ["Cart", "Hello, Ana!", "3 items"] {
        assert!(
            initial.contains(&expected.to_string()),
            "{expected} in {initial:?}"
        );
    }

    patches.lock().unwrap().clear();
    engine.set_context("t", hr_catalog());
    let switched = strings(&patches.lock().unwrap());
    assert_eq!(
        switched.iter().filter(|s| *s == "Košarica").count(),
        2,
        "both title forms re-render: {switched:?}"
    );
    assert!(switched.contains(&"Bok, Ana!".to_string()), "{switched:?}");
    assert!(switched.contains(&"3 stavke".to_string()), "{switched:?}");
}

#[test]
fn state_change_reselects_plural_category() {
    let mut engine = engine_with(json!({ "count": 1 }));
    engine.set_context("t", hr_catalog());
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(&mut engine, r#"Text("@{plural(state.count, t.items)}")"#);
    assert!(strings(&patches.lock().unwrap()).contains(&"1 stavka".to_string()));

    for (n, expected) in [(5, "5 stavki"), (22, "22 stavke"), (21, "21 stavka")] {
        patches.lock().unwrap().clear();
        engine.update_state(None, json!({ "count": n }));
        let got = strings(&patches.lock().unwrap());
        assert!(got.contains(&expected.to_string()), "{expected} in {got:?}");
    }
}

#[test]
fn missing_keys_render_the_key_path() {
    let mut engine = engine_with(json!({ "name": "Ana" }));
    engine.set_context("t", en_catalog());
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Column {
            Text(@t.cart.nope)
            Text("@{t.cart.nope2}")
            Text("@{fmt(t.missing.deep, state.name)}")
            Text("@{plural(2, t.nothing)}")
        }"#,
    );
    let got = strings(&patches.lock().unwrap());
    for expected in ["cart.nope", "cart.nope2", "missing.deep", "nothing"] {
        assert!(got.contains(&expected.to_string()), "{expected} in {got:?}");
    }
    assert!(
        !got.iter()
            .any(|s| s.is_empty() || s == "null" || s.contains("@{")),
        "{got:?}"
    );
}

#[test]
fn missing_key_appears_once_the_catalog_gains_it() {
    let mut engine = engine_with(json!({}));
    engine.set_context("t", json!({}));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(&mut engine, r#"Text("@{t.late}")"#);
    assert!(strings(&patches.lock().unwrap()).contains(&"late".to_string()));
    patches.lock().unwrap().clear();
    engine.set_context("t", json!({ "late": "Loaded" }));
    assert!(strings(&patches.lock().unwrap()).contains(&"Loaded".to_string()));
}

#[test]
fn translated_rows_inside_foreach() {
    let mut engine =
        engine_with(json!({ "rows": [ { "id": "a", "n": 1 }, { "id": "b", "n": 4 } ] }));
    engine.set_context("t", hr_catalog());
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Column {
            ForEach(items: @state.rows, key: "id") {
                Text("@{plural(item.n, t.items)}")
            }
        }"#,
    );
    let got = strings(&patches.lock().unwrap());
    assert!(got.contains(&"1 stavka".to_string()), "{got:?}");
    assert!(got.contains(&"4 stavke".to_string()), "{got:?}");

    patches.lock().unwrap().clear();
    engine.set_context("t", en_catalog());
    let got = strings(&patches.lock().unwrap());
    assert!(got.contains(&"1 item".to_string()), "{got:?}");
    assert!(got.contains(&"4 items".to_string()), "{got:?}");

    // Row data changes (update + insert) keep translating.
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({ "rows": [ { "id": "a", "n": 2 }, { "id": "b", "n": 4 }, { "id": "c", "n": 1 } ] }),
    );
    let got = strings(&patches.lock().unwrap());
    assert!(got.contains(&"2 items".to_string()), "{got:?}");
    assert!(got.contains(&"1 item".to_string()), "{got:?}");
    assert!(!got.iter().any(|s| s.contains("@{")), "{got:?}");
}

#[test]
fn other_providers_keep_null_for_missing_paths() {
    let mut engine = engine_with(json!({}));
    engine.set_context("spacetime", json!({}));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(&mut engine, r#"Text(@spacetime.nope)"#);
    let got = strings(&patches.lock().unwrap());
    assert!(!got.contains(&"nope".to_string()), "{got:?}");
}
