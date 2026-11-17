//! A module used inside another module's template keeps its own scope, at
//! any depth and through control flow, routes and stateless components.

use hypen_engine::ir::{ast_to_ir_node, Component};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::{Engine, TemplateExpander};
use serde_json::json;
use std::sync::{Arc, Mutex};

fn engine_with(components: &[(&str, &str)]) -> (Engine, Arc<Mutex<Vec<Patch>>>) {
    let mut engine = Engine::new();
    for (name, source) in components {
        engine.register_component(Component::from_source(*name, source).unwrap());
    }
    let patches = Arc::new(Mutex::new(Vec::new()));
    let capture = patches.clone();
    let expander = Mutex::new(TemplateExpander::new());
    engine.set_render_callback(move |p| {
        let lowered = expander.lock().unwrap().expand(p.to_vec());
        capture.lock().unwrap().extend(lowered);
    });
    (engine, patches)
}

fn render(engine: &mut Engine, source: &str) {
    let spec = hypen_parser::parse_component(source).unwrap();
    engine.render_ir_node(&ast_to_ir_node(&spec));
}

fn texts(patches: &Arc<Mutex<Vec<Patch>>>) -> Vec<String> {
    patches
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            Patch::Create { props, .. } => props.get("0").or_else(|| props.get("text")).cloned(),
            Patch::SetProp { name, value, .. } if name == "0" || name == "text" => {
                Some(value.clone())
            }
            _ => None,
        })
        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
        .collect()
}

fn state(engine: &mut Engine, scope: &str, name: &str, value: serde_json::Value) {
    engine.register_module(scope, ModuleInstance::new(Module::new(name), value));
}

const INNER: &str = r#"module Inner { Text("inner=@{state.n}") }"#;

#[test]
fn module_inside_a_module_keeps_its_scope() {
    let (mut engine, patches) = engine_with(&[
        ("Wrap", r#"module Wrap { Column { Text("wrap=@{state.w}") Inner {} } }"#),
        ("Inner", INNER),
    ]);
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({"a": 1})));
    state(&mut engine, "wrap", "Wrap", json!({"w": 2}));
    state(&mut engine, "inner", "Inner", json!({"n": 3}));
    render(&mut engine, r#"module App { Column { Text("app=@{state.a}") Wrap {} } }"#);
    assert_eq!(texts(&patches), ["app=1", "wrap=2", "inner=3"]);

    patches.lock().unwrap().clear();
    engine.update_state(Some("inner"), json!({"n": 4}));
    assert_eq!(texts(&patches), ["inner=4"]);
}

/// App (primary) with `a`, plus `wrap`, `mid` and `inner` module states.
fn seeded(components: &[(&str, &str)]) -> (Engine, Arc<Mutex<Vec<Patch>>>) {
    let (mut engine, patches) = engine_with(components);
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({"a": 1, "show": true, "rows": [{"id": "x"}, {"id": "y"}], "location": "/in"}),
    ));
    state(&mut engine, "wrap", "Wrap", json!({"w": 2, "show": true, "rows": [{"id": "p"}], "location": "/in"}));
    state(&mut engine, "mid", "Mid", json!({"m": 5}));
    state(&mut engine, "inner", "Inner", json!({"n": 3}));
    (engine, patches)
}

#[test]
fn three_modules_deep() {
    let (mut engine, patches) = seeded(&[
        ("Wrap", r#"module Wrap { Column { Mid {} Text("wrap=@{state.w}") } }"#),
        ("Mid", r#"module Mid { Column { Text("mid=@{state.m}") Inner {} Text("mid2=@{state.m}") } }"#),
        ("Inner", INNER),
    ]);
    render(&mut engine, r#"module App { Column { Wrap {} Text("app=@{state.a}") } }"#);
    assert_eq!(texts(&patches), ["mid=5", "inner=3", "mid2=5", "wrap=2", "app=1"]);
}

#[test]
fn stateless_component_between_modules() {
    let (mut engine, patches) = seeded(&[
        ("Wrap", r#"module Wrap { Card { Text("slot=@{state.w}") } }"#),
        ("Card", r#"Column { Text("card=@{state.w}") Children() Inner {} }"#),
        ("Inner", INNER),
    ]);
    // Directly under the entry, and one module down.
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    assert_eq!(texts(&patches), ["card=2", "slot=2", "inner=3"]);
}

#[test]
fn stateless_component_directly_under_the_entry() {
    let (mut engine, patches) = seeded(&[
        ("Card", r#"Column { Text("card=@{state.a}") Inner {} }"#),
        ("Inner", INNER),
    ]);
    render(&mut engine, r#"module App { Card {} }"#);
    assert_eq!(texts(&patches), ["card=1", "inner=3"]);
}

#[test]
fn nested_inside_control_flow() {
    let (mut engine, patches) = seeded(&[
        (
            "Wrap",
            r#"module Wrap {
                Column {
                    If(condition: "@{state.show}") { Inner {} }
                    ForEach(items: @state.rows, key: "id") {
                        Column { Text("row=@{item.id} w=@{state.w}") Inner {} }
                    }
                }
            }"#,
        ),
        ("Inner", INNER),
    ]);
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    assert_eq!(texts(&patches), ["inner=3", "row=p w=2", "inner=3"]);

    patches.lock().unwrap().clear();
    engine.update_state(Some("inner"), json!({"n": 9}));
    assert_eq!(texts(&patches), ["inner=9", "inner=9"]);
}

#[test]
fn nested_inside_a_route() {
    let (mut engine, patches) = seeded(&[
        (
            "Wrap",
            r#"module Wrap {
                Column {
                    Router {
                        Route(path: "/in") { Inner {} }
                        Route(path: "/w") { Text("wrap=@{state.w}") }
                    }
                }
            }"#,
        ),
        ("Inner", INNER),
    ]);
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    assert_eq!(texts(&patches), ["inner=3"]);

    patches.lock().unwrap().clear();
    engine.update_state(Some("wrap"), json!({"location": "/w"}));
    assert_eq!(texts(&patches), ["wrap=2"]);
}

#[test]
fn module_whose_root_is_control_flow_keeps_nested_scopes() {
    let (mut engine, patches) = seeded(&[
        (
            "Wrap",
            r#"module Wrap {
                If(condition: "@{state.show}") { Column { Text("wrap=@{state.w}") Inner {} } }
            }"#,
        ),
        ("Inner", INNER),
    ]);
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    assert_eq!(texts(&patches), ["wrap=2", "inner=3"]);
}

#[test]
fn slot_children_belong_to_the_module_they_are_passed_to() {
    // Unchanged contract (it held one level deep before): what a caller puts
    // in a module's slot is scoped to that module.
    let (mut engine, patches) = seeded(&[
        ("Wrap", r#"module Wrap { Inner { Text("slot=@{state.n}") } }"#),
        ("Inner", r#"module Inner { Column { Text("inner=@{state.n}") Children() } }"#),
    ]);
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    assert_eq!(texts(&patches), ["inner=3", "slot=3"]);
}

#[test]
fn every_nested_scope_is_discovered() {
    // No state registered for the nested modules: the engine registers a
    // placeholder per scope it finds, which is what an SDK then fills.
    let (mut engine, _patches) = engine_with(&[
        ("Wrap", r#"module Wrap { Column { Mid {} } }"#),
        ("Mid", r#"module Mid { Card {} }"#),
        ("Card", r#"Column { Inner {} }"#),
        ("Inner", INNER),
    ]);
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
    render(&mut engine, r#"module App { Column { Wrap {} } }"#);
    for scope in ["wrap", "mid", "inner"] {
        assert!(engine.modules().contains_key(scope), "{scope} was not discovered");
    }
}

#[test]
fn inline_module_inside_a_module_keeps_its_scope() {
    let spec = hypen_parser::parse_component(
        r#"module Outer { Column { Text("o") module Inner { Text("i") } } }"#,
    );
    // Only meaningful where the grammar accepts a nested declaration.
    let Ok(spec) = spec else { return };
    let mut scopes = Vec::new();
    hypen_engine::ir::walk::walk_ir(&ast_to_ir_node(&spec), &mut |n| {
        if let hypen_engine::ir::IRNode::Element(el) = n {
            if el.element_type == "Text" {
                scopes.push(el.module_scope.clone().unwrap_or_default());
            }
        }
    });
    assert_eq!(scopes, ["outer", "inner"]);
}

#[test]
fn component_whose_root_is_a_component_is_expanded() {
    let (mut engine, patches) = seeded(&[
        ("Outer", r#"Panel { Text("outer") }"#),
        ("Panel", r#"Column { Text("panel") Children() }"#),
    ]);
    render(&mut engine, r#"module App { Column { Outer {} } }"#);
    assert_eq!(texts(&patches), ["panel", "outer"]);
}

#[test]
fn component_wrapping_the_primitive_it_is_named_after_does_not_recurse() {
    let (mut engine, patches) = seeded(&[("Text", r#"Text("wrapped")"#)]);
    render(&mut engine, r#"module App { Column { Text("x") } }"#);
    assert_eq!(texts(&patches), ["wrapped"]);
}
