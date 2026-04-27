mod common;
use common::*;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

#[test]
fn debug_state_update() {
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let element = text_element_with_binding("count");
    engine.render(&element);

    println!("After initial render - revision: {}", engine.revision());

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    println!("Calling update_state...");
    engine.update_state(None, json!({"count": 1}));

    println!("After update_state - revision: {}", engine.revision());

    let captured = patches.lock().unwrap();
    println!("Patches generated: {}", captured.len());
    for (i, patch) in captured.iter().enumerate() {
        println!("[{}] {:?}", i, patch);
    }
}
