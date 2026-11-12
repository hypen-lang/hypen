//! Color-scheme value maps through the full pipeline:
//! `.color({ default: "#111", dark: "#fff" })` lowers to one scheme-switched
//! base prop, resolved by the engine against the theme's `appearance.scheme`
//! data source, with breakpoint / state variants still layered on top.

mod common;

use common::*;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use serde_json::{json, Value};

fn render(engine: &mut Engine, source: &str) {
    let component = hypen_parser::parse_component(source).expect("parse");
    let ir = hypen_engine::ir::ast_to_ir_node(&component);
    engine.render_ir_node(&ir);
}

fn engine_with(state: Value) -> Engine {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("Page"), state));
    engine
}

fn appearance(scheme: &str) -> Value {
    json!({ "scheme": scheme, "preference": "system", "system": scheme, "schemes": ["dark"] })
}

/// `(name, value)` of every prop on Create patches whose name starts with `prefix`.
fn created(patches: &[Patch], prefix: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for p in patches {
        if let Patch::Create { props, .. } = p {
            for (k, v) in props.iter() {
                if k.starts_with(prefix) {
                    out.push((k.clone(), v.clone()));
                }
            }
        }
    }
    out
}

/// Prop changes as `name=value` (SetProp) / `name-` (RemoveProp); anything
/// else is reported as its debug form so an unexpected patch fails the test.
fn changes(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .map(|p| match p {
            Patch::SetProp { name, value, .. } => format!("{name}={value}"),
            Patch::RemoveProp { name, .. } => format!("{name}-"),
            other => format!("{other:?}"),
        })
        .collect()
}

#[test]
fn the_active_scheme_picks_the_case_and_a_switch_rerenders_only_that_prop() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Column {
            Text("Hi").color({ default: "#111111", dark: "#ffffff" }).padding(8)
            Text("Plain").color("#333333")
        }"##,
    );
    assert_eq!(
        created(&patches.lock().unwrap(), "color"),
        [
            ("color.0".to_string(), json!("#111111")),
            ("color.0".to_string(), json!("#333333")),
        ]
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#ffffff\""]);

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("light"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#111111\""]);
}

#[test]
fn values_keep_their_type() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Text("Hi").opacity({ default: 1, dark: 0.8 }).bold({ light: false, dark: true })"#,
    );
    let got = patches.lock().unwrap();
    assert_eq!(
        created(&got, "opacity"),
        [("opacity.0".to_string(), json!(0.8))]
    );
    assert_eq!(created(&got, "bold"), [("bold.0".to_string(), json!(true))]);
}

#[test]
fn without_a_theme_the_default_applies_and_registering_one_later_takes_effect() {
    let mut engine = engine_with(json!({}));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Text("Hi").color({ default: "#111111", dark: "#ffffff" })"##,
    );
    assert_eq!(
        created(&patches.lock().unwrap(), "color"),
        [("color.0".to_string(), json!("#111111"))]
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#ffffff\""]);
}

#[test]
fn a_scheme_without_a_case_or_default_leaves_the_prop_absent() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(&mut engine, r##"Text("Hi").color({ dark: "#ffffff" })"##);
    assert_eq!(created(&patches.lock().unwrap(), "color"), []);

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#ffffff\""]);

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("light"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0-"]);

    // A scheme the map does not name (a custom one) is a miss too.
    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("sepia"));
    assert_eq!(changes(&patches.lock().unwrap()), Vec::<String>::new());
}

#[test]
fn breakpoint_and_state_variants_layer_on_the_scheme_switched_base() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Text("Hi").color({ default: "#111111", dark: "#ffffff", md: "#00ff00", hover: "#ff0000" })"##,
    );
    assert_eq!(
        created(&patches.lock().unwrap(), "color"),
        [
            ("color.0".to_string(), json!("#ffffff")),
            ("color@md.0".to_string(), json!("#00ff00")),
            ("color:hover.0".to_string(), json!("#ff0000")),
        ]
    );

    // The renderer-resolved variants do not depend on the scheme.
    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("light"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#111111\""]);
}

#[test]
fn rows_of_a_list_follow_the_scheme() {
    let mut engine =
        engine_with(json!({ "items": [{ "id": 1, "t": "a" }, { "id": 2, "t": "b" }] }));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Column {
            ForEach(items: @state.items, key: "id") {
                Text("@{item.t}").color({ default: "#111111", dark: "#ffffff" })
            }
        }"##,
    );
    assert_eq!(created(&patches.lock().unwrap(), "color").len(), 2);

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    assert_eq!(
        changes(&patches.lock().unwrap()),
        ["color.0=\"#ffffff\"", "color.0=\"#ffffff\""]
    );

    // A row created after the switch starts in the active scheme.
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({ "items": [{ "id": 1, "t": "a" }, { "id": 2, "t": "b" }, { "id": 3, "t": "c" }] }),
    );
    let got = patches.lock().unwrap();
    let colors: Vec<Value> = created(&got, "color").into_iter().map(|(_, v)| v).collect();
    let instantiated = format!("{got:?}");
    assert!(
        colors == [json!("#ffffff")] || instantiated.contains("#ffffff"),
        "new row is dark: {instantiated}"
    );
    assert!(!instantiated.contains("#111111"), "{instantiated}");
}

#[test]
fn a_non_literal_beside_scheme_keys_drops_the_scheme_form() {
    let mut engine = engine_with(json!({ "ink": "#222222" }));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Column {
            Text("a").color({ default: @state.ink, dark: "#ffffff" })
            Text("b").backgroundColor({ default: "#eeeeee", dark: @state.ink })
        }"##,
    );
    let got = patches.lock().unwrap();
    // The light/dark values are ignored (with a warning); `default` lowers as before.
    assert_eq!(
        created(&got, "color"),
        [("color.0".to_string(), json!("#222222"))]
    );
    assert_eq!(
        created(&got, "backgroundColor"),
        [("backgroundColor.0".to_string(), json!("#eeeeee"))]
    );
}

#[test]
fn a_map_with_other_keys_is_still_an_ordinary_argument() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(&mut engine, r#"Text("Hi").shadow({ dark: 4, blur: 8 })"#);
    assert_eq!(
        created(&patches.lock().unwrap(), "shadow"),
        [("shadow.0".to_string(), json!({ "dark": 4.0, "blur": 8.0 }))]
    );
}

#[test]
fn tailwind_dark_utilities_switch_with_the_scheme() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Text("Hi").tw("bg-white dark:bg-black dark:opacity-50 p-4")"#,
    );
    {
        let got = patches.lock().unwrap();
        let bg = created(&got, "backgroundColor");
        assert_eq!(bg.len(), 1, "one base prop, no stray dark key: {bg:?}");
        assert_eq!(bg[0].0, "backgroundColor.0");
        // No base opacity: absent in light.
        assert_eq!(created(&got, "opacity"), []);
    }
    let light_bg = created(&patches.lock().unwrap(), "backgroundColor")[0]
        .1
        .clone();

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    let dark = changes(&patches.lock().unwrap());
    assert_eq!(dark.len(), 2, "{dark:?}");
    assert!(
        dark.iter().any(|c| c.starts_with("backgroundColor.0=")),
        "{dark:?}"
    );
    assert!(dark.iter().any(|c| c.starts_with("opacity.0=")), "{dark:?}");
    assert!(
        !dark.contains(&format!("backgroundColor.0={light_bg}")),
        "{dark:?}"
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("light"));
    let light = changes(&patches.lock().unwrap());
    assert!(
        light.contains(&format!("backgroundColor.0={light_bg}")),
        "{light:?}"
    );
    assert!(light.contains(&"opacity.0-".to_string()), "{light:?}");
}
