//! `Icon` names that are bound (`Icon("@{item.icon}")` per ForEach row,
//! `Icon(@state.icon)`) resolve against the resource registry at render,
//! like a static `Icon("heart")` does at template load, and follow state.

use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::{ast_to_ir_node, Engine, TemplateExpander};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const HEART: &str = r#"<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>"#;
const STAR: &str = r#"<svg viewBox="0 0 20 20"><path d="M3 3L4 4"/></svg>"#;

/// Renderer-side view: id -> (element type, props), applying the lowered
/// Create/SetProp/RemoveProp stream.
#[derive(Default)]
struct View {
    nodes: IndexMap<String, (String, serde_json::Map<String, Value>)>,
    expander: TemplateExpander,
}

impl View {
    fn apply(&mut self, raw: Vec<Patch>) {
        for patch in self.expander.expand(raw) {
            match patch {
                Patch::Create {
                    id,
                    element_type,
                    props,
                    ..
                } => {
                    let map = props.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    self.nodes.insert(id.to_string(), (element_type, map));
                }
                Patch::SetProp { id, name, value } => {
                    if let Some((_, props)) = self.nodes.get_mut(&*id) {
                        props.insert(name, value);
                    }
                }
                Patch::RemoveProp { id, name } => {
                    if let Some((_, props)) = self.nodes.get_mut(&*id) {
                        props.remove(&name);
                    }
                }
                _ => {}
            }
        }
    }

    /// (name, viewBox) for every Icon, in creation order.
    fn icons(&self) -> Vec<(Value, Option<Value>)> {
        self.nodes
            .values()
            .filter(|(ty, _)| ty == "Icon")
            .map(|(_, p)| (p["0"].clone(), p.get("__iconViewBox").cloned()))
            .collect()
    }
}

#[test]
fn bound_icon_names_resolve_per_row_and_follow_state() {
    let mut engine = Engine::new();
    engine.register_resource("heart", HEART);
    engine.register_resource("star", STAR);
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({"rows": [{"icon": "heart"}, {"icon": "star"}], "current": "star"}),
    ));
    let sink: Arc<Mutex<Vec<Patch>>> = Arc::default();
    let captured = sink.clone();
    engine.set_render_callback(move |p| captured.lock().unwrap().extend(p.iter().cloned()));

    let doc = hypen_parser::parse_document(
        r#"Column {
            ForEach(items: @state.rows) { Icon("@{item.icon}") }
            Icon(@state.current)
            Icon("heart")
        }"#,
    )
    .unwrap();
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));

    let mut view = View::default();
    view.apply(std::mem::take(&mut *sink.lock().unwrap()));
    assert_eq!(
        view.icons(),
        vec![
            (json!("heart"), Some(json!("0 0 24 24"))),
            (json!("star"), Some(json!("0 0 20 20"))),
            (json!("star"), Some(json!("0 0 20 20"))),
            (json!("heart"), Some(json!("0 0 24 24"))),
        ]
    );

    // State changes re-resolve the bound names; an unknown name withdraws
    // the stale data so the renderer falls back to its placeholder.
    engine.update_state(
        None,
        json!({"rows": [{"icon": "star"}, {"icon": "nope"}], "current": "heart"}),
    );
    view.apply(std::mem::take(&mut *sink.lock().unwrap()));
    let icons = view.icons();
    assert!(
        icons.contains(&(json!("star"), Some(json!("0 0 20 20"))))
            && icons.contains(&(json!("nope"), None))
            && icons
                .iter()
                .filter(|i| **i == (json!("heart"), Some(json!("0 0 24 24"))))
                .count()
                == 2,
        "{icons:?}"
    );
    for (_, props) in view.nodes.values().filter(|(ty, _)| ty == "Icon") {
        assert_eq!(props.contains_key("__iconPaths"), props.contains_key("__iconViewBox"));
    }
}
