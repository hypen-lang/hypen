//! Components whose template root is a control-flow node (Router / If / When /
//! ForEach) rather than an Element.
//!
//! `module App { Router { Route(path: "/") { Home() } } }` lowers to an
//! `IRNode::Router` root once the module wrapper is unwrapped. Registration
//! used to reject anything but an Element root ("component root must be an
//! element"), so such templates could only be mounted as the root UI.

use hypen_engine::ir::{ast_to_ir_node, Component, IRNode, ResolvedComponent};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use serde_json::json;
use std::sync::{Arc, Mutex};

const APP: &str = r#"
module App {
    Router {
        Route(path: "/") { Text("home") }
        Route(path: "/about") { Text("about") }
    }
}
"#;

fn capture(engine: &mut Engine) -> Arc<Mutex<Vec<Patch>>> {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let s = sink.clone();
    engine.set_render_callback(move |p| s.lock().unwrap().extend_from_slice(p));
    sink
}

fn created_texts(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create {
                element_type,
                props,
                ..
            } if element_type == "Text" => props
                .get("0")
                .or_else(|| props.get("text"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
            _ => None,
        })
        .collect()
}

fn root(src: &str) -> IRNode {
    ast_to_ir_node(&hypen_parser::parse_component(src).expect("parse"))
}

fn app_engine() -> Engine {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("Shell"), json!({})));
    engine.register_module(
        "app",
        ModuleInstance::new(Module::new("App"), json!({ "location": "/" })),
    );
    engine
}

#[test]
fn resolver_registers_router_root_module() {
    let mut engine = app_engine();
    engine.set_component_resolver(|name, _ctx| {
        (name == "App").then(|| ResolvedComponent {
            source: APP.to_string(),
            path: "/App.hypen".to_string(),
            passthrough: false,
            lazy: false,
        })
    });
    let sink = capture(&mut engine);

    engine.render_ir_node(&root(r#"Column { App() }"#));

    let texts = created_texts(&sink.lock().unwrap());
    assert_eq!(
        texts,
        vec!["home".to_string()],
        "a Router-root component must expand in place and render its matched route"
    );
}

#[test]
fn from_source_router_root_navigates() {
    let mut engine = app_engine();
    let comp = Component::from_source("App", APP)
        .expect("Router-root templates are registrable")
        .with_source_path("/App.hypen");
    assert!(comp.is_module);
    assert_eq!(comp.module_name.as_deref(), Some("app"));
    engine.register_component(comp);
    let sink = capture(&mut engine);

    engine.render_ir_node(&root(r#"Column { App() }"#));
    assert_eq!(
        created_texts(&sink.lock().unwrap()),
        vec!["home".to_string()]
    );

    sink.lock().unwrap().clear();
    engine.update_state(Some("app"), json!({ "location": "/about" }));
    assert_eq!(
        created_texts(&sink.lock().unwrap()),
        vec!["about".to_string()],
        "the Router's location binding must be scoped to the App module"
    );
}

#[test]
fn from_source_if_root_component() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("M"), json!({ "on": true })));
    engine.register_component(
        Component::from_source(
            "Maybe",
            r#"If(@state.on) { Text("yes") Else { Text("no") } }"#,
        )
        .expect("If-root templates are registrable"),
    );
    let sink = capture(&mut engine);
    engine.render_ir_node(&root(r#"Column { Maybe() }"#));
    assert_eq!(
        created_texts(&sink.lock().unwrap()),
        vec!["yes".to_string()]
    );
}
