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
fn entries_can_be_bindings_and_follow_what_they_bind_to() {
    let mut engine = engine_with(json!({ "ink": "#222222", "glow": "#ffee00" }));
    engine.set_context("appearance", appearance("light"));
    engine.set_context("theme", json!({ "color": { "paper": "#fafafa" } }));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Column {
            Text("a").color({ default: @state.ink, dark: @state.glow })
            Text("b").backgroundColor({ default: @theme.color.paper, dark: "#000000" })
            Text("c").borderColor({ default: "#cccccc", dark: "@{state.glow}" })
        }"##,
    );
    {
        let got = patches.lock().unwrap();
        assert_eq!(
            created(&got, "color"),
            [("color.0".to_string(), json!("#222222"))]
        );
        assert_eq!(
            created(&got, "backgroundColor"),
            [("backgroundColor.0".to_string(), json!("#fafafa"))]
        );
        assert_eq!(
            created(&got, "borderColor"),
            [("borderColor.0".to_string(), json!("#cccccc"))]
        );
    }

    // The entry in effect is live: its state and token changes re-render.
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({ "ink": "#333333" }));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#333333\""]);
    patches.lock().unwrap().clear();
    engine.set_context("theme", json!({ "color": { "paper": "#f0f0f0" } }));
    assert_eq!(
        changes(&patches.lock().unwrap()),
        ["backgroundColor.0=\"#f0f0f0\""]
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    let mut dark = changes(&patches.lock().unwrap());
    dark.sort();
    assert_eq!(
        dark,
        [
            "backgroundColor.0=\"#000000\"",
            "borderColor.0=\"#ffee00\"",
            "color.0=\"#ffee00\"",
        ]
    );

    // …and the entry that is NOT in effect changing renders nothing new.
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({ "ink": "#444444" }));
    assert_eq!(changes(&patches.lock().unwrap()), Vec::<String>::new());
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({ "glow": "#ffcc00" }));
    let mut glow = changes(&patches.lock().unwrap());
    glow.sort();
    assert_eq!(glow, ["borderColor.0=\"#ffcc00\"", "color.0=\"#ffcc00\""]);
}

#[test]
fn entries_can_read_the_row_of_a_list() {
    let mut engine = engine_with(json!({ "items": [
        { "id": 1, "day": "#111111", "night": "#eeeeee" },
        { "id": 2, "day": "#222222", "night": "#dddddd" },
    ] }));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Column {
            ForEach(items: @state.items, key: "id") {
                Text("row").color({ default: @item.day, dark: @item.night })
            }
        }"##,
    );
    let light: Vec<Value> = created(&patches.lock().unwrap(), "color")
        .into_iter()
        .map(|(_, v)| v)
        .collect();
    assert_eq!(light, [json!("#111111"), json!("#222222")]);

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    assert_eq!(
        changes(&patches.lock().unwrap()),
        ["color.0=\"#eeeeee\"", "color.0=\"#dddddd\""]
    );

    // An item edit while dark re-renders the dark entry of that row only.
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({ "items": [
            { "id": 1, "day": "#111111", "night": "#cccccc" },
            { "id": 2, "day": "#222222", "night": "#dddddd" },
        ] }),
    );
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#cccccc\""]);
}

#[test]
fn custom_schemes_are_keys_beside_a_default() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Text("Hi").color({ default: "#111111", dark: "#ffffff", sepia: "#5b4636", md: "#00ff00" })"##,
    );
    assert_eq!(
        created(&patches.lock().unwrap(), "color"),
        [
            ("color.0".to_string(), json!("#111111")),
            ("color@md.0".to_string(), json!("#00ff00")),
        ]
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("sepia"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#5b4636\""]);

    // A scheme the map has no key for falls back to `default`.
    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("highContrast"));
    assert_eq!(changes(&patches.lock().unwrap()), ["color.0=\"#111111\""]);
}

#[test]
fn an_action_or_resource_entry_drops_the_scheme_form() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r##"Text("a").color({ default: "#111111", dark: @actions.nope })"##,
    );
    // The scheme values are ignored (with a warning); `default` lowers as before.
    assert_eq!(
        created(&patches.lock().unwrap(), "color"),
        [("color.0".to_string(), json!("#111111"))]
    );
}

#[test]
fn a_map_with_other_keys_is_still_an_ordinary_argument() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("dark"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    // No `default`, so `blur` cannot be a scheme name: an ordinary object.
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

#[test]
fn tailwind_dark_combined_with_a_breakpoint_or_state_switches_that_variant() {
    let mut engine = engine_with(json!({}));
    engine.set_context("appearance", appearance("light"));
    let (patches, cb) = patch_capture();
    engine.set_render_callback(cb);
    render(
        &mut engine,
        r#"Text("Hi").tw("bg-white md:bg-gray-100 dark:md:bg-gray-900 dark:hover:bg-black")"#,
    );
    let (base, md_light) = {
        let got = patches.lock().unwrap();
        let bg = created(&got, "backgroundColor");
        let keys: Vec<&str> = bg.iter().map(|(k, _)| k.as_str()).collect();
        // The dark-only hover variant is absent in light; no stray "dark" key.
        assert_eq!(
            keys,
            ["backgroundColor.0", "backgroundColor@md.0"],
            "{bg:?}"
        );
        (bg[0].1.clone(), bg[1].1.clone())
    };

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("dark"));
    let dark = changes(&patches.lock().unwrap());
    assert_eq!(dark.len(), 2, "{dark:?}");
    assert!(
        dark.iter().any(|c| c.starts_with("backgroundColor@md.0=")
            && *c != format!("backgroundColor@md.0={md_light}")),
        "{dark:?}"
    );
    assert!(
        dark.iter()
            .any(|c| c.starts_with("backgroundColor:hover.0=")),
        "{dark:?}"
    );

    patches.lock().unwrap().clear();
    engine.set_context("appearance", appearance("light"));
    let mut light = changes(&patches.lock().unwrap());
    light.sort();
    assert_eq!(
        light,
        [
            "backgroundColor:hover.0-".to_string(),
            format!("backgroundColor@md.0={md_light}"),
        ]
    );
    let _ = base;
}
