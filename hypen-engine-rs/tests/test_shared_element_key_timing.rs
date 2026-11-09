//! `.sharedElement` keys that bind module state which has not arrived yet.
//!
//! Report (examples/social, Story.hypen):
//! `.sharedElement("story-@{state.story.id}")` rendered on navigation while
//! `state.story` was still `null` (the Story module fills it in
//! `onActivated`, which runs after the route renders). The engine fell back
//! to the RAW template text, so the navigation batch carried the literal key
//! `story-@{state.story.id}` and the renderer warned "Shared-element keys
//! matched nothing ... target-only: [story-@{state.story.id}]".
//!
//! Engine contract pinned here:
//! 1. An unresolvable bound key is ABSENT (no identity yet), never the raw
//!    DSL text — raw text is not an identity and two unrelated unresolved
//!    templates with the same text would falsely match.
//! 2. When the key resolves, it arrives as `SetProp` on the existing node.
//! 3. When the module state is written BEFORE the navigation renders (the
//!    SDK ordering fix), the navigation batch itself carries the resolved key.

use hypen_engine::ir::{ast_to_ir_node, Component};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::{Engine, TemplateExpander};
use serde_json::json;
use std::sync::{Arc, Mutex};

const KEY: &str = "__anim.sharedKey";

const STORY: &str = r#"
module Story {
    Stack {
        Image(src: "@{state.story.imageUrl}")
            .sharedElement("story-@{state.story.id}", curve: spring, duration: 380)
    }
}
"#;

const APP: &str = r#"
Column {
    Router {
        Route(path: "/") { Text("home") }
        Route(path: "/story/:id") { Story() }
    }
}
"#;

struct Harness {
    engine: Engine,
    sink: Arc<Mutex<Vec<Patch>>>,
}

impl Harness {
    fn new(story: serde_json::Value) -> Self {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("App"),
            json!({ "location": "/" }),
        ));
        engine.register_module("story", ModuleInstance::new(Module::new("Story"), story));
        engine.register_component(Component::from_source("Story", STORY).unwrap());
        let sink: Arc<Mutex<Vec<Patch>>> = Arc::default();
        let s = sink.clone();
        engine.set_render_callback(move |p| s.lock().unwrap().extend_from_slice(p));
        engine.render_ir_node(&ast_to_ir_node(
            &hypen_parser::parse_component(APP).unwrap(),
        ));
        sink.lock().unwrap().clear();
        Harness { engine, sink }
    }

    fn take(&self) -> Vec<Patch> {
        TemplateExpander::new().expand(std::mem::take(&mut *self.sink.lock().unwrap()))
    }

    fn navigate(&mut self, to: &str) -> Vec<Patch> {
        self.engine.update_state(None, json!({ "location": to }));
        self.take()
    }
}

/// The `__anim.sharedKey` value an Image receives in `patches`, from its
/// Create props or a later SetProp. `Some(None)` = created without a key.
fn image_key(patches: &[Patch]) -> Option<Option<serde_json::Value>> {
    let mut image_id = None;
    let mut key = None;
    for p in patches {
        match p {
            Patch::Create {
                id,
                element_type,
                props,
                ..
            } if element_type == "Image" => {
                image_id = Some(id.clone());
                key = Some(props.get(KEY).cloned());
            }
            Patch::SetProp { id, name, value }
                if name == KEY && (image_id.is_none() || image_id.as_ref() == Some(id)) =>
            {
                key = Some(Some(value.clone()));
            }
            _ => {}
        }
    }
    key
}

#[test]
fn unresolved_shared_key_is_absent_not_raw_template() {
    let mut h = Harness::new(json!({ "story": null }));
    let patches = h.navigate("/story/u1");
    let key = image_key(&patches).expect("the Story image is created on navigation");
    assert!(
        key.is_none(),
        "an unresolvable bound key must be absent, not the raw DSL: {key:?}"
    );
}

#[test]
fn shared_key_arrives_as_setprop_once_state_lands() {
    let mut h = Harness::new(json!({ "story": null }));
    h.navigate("/story/u1");
    h.engine.update_state(
        Some("story"),
        json!({ "story": { "id": "u1", "imageUrl": "u1.png" } }),
    );
    let patches = h.take();
    assert!(
        patches.iter().any(|p| matches!(p,
            Patch::SetProp { name, value, .. } if name == KEY && value == &json!("story-u1"))),
        "{patches:?}"
    );
}

#[test]
fn state_written_before_navigation_rides_the_navigation_batch() {
    // The SDK-side ordering fix: activate the route's module (onActivated
    // writes state.story) BEFORE mirroring the new location into state.
    let mut h = Harness::new(json!({ "story": null }));
    h.engine.update_state(
        Some("story"),
        json!({ "story": { "id": "u1", "imageUrl": "u1.png" } }),
    );
    assert!(h.take().is_empty(), "the Story route is not rendered yet");
    let patches = h.navigate("/story/u1");
    assert_eq!(
        image_key(&patches),
        Some(Some(json!("story-u1"))),
        "the navigation batch must carry the resolved key: {patches:?}"
    );
}
