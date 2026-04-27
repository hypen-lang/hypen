//! Debug test to understand state binding behavior

mod common;

use common::*;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

#[test]
fn debug_state_binding_patches() {
    // GIVEN: Element with @{state.name} binding
    let mut engine = Engine::new();
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, json!({"name": "Alice"}));
    engine.set_module(module);

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render with state binding
    let element = text_element_with_binding("name");

    println!("=== Element structure ===");
    println!("Element type: {}", element.element_type);
    println!("Props: {:?}", element.props);

    engine.render(&element);

    // THEN: Print all patches to understand what's happening
    let captured = patches.lock().unwrap();
    println!("\n=== Generated patches ({}) ===", captured.len());
    for (i, patch) in captured.iter().enumerate() {
        println!("[{}] {:?}", i, patch);
    }

    // Check if there's a SetProp with "Alice"
    let has_alice = captured.iter().any(|p| {
        if let hypen_engine::reconcile::Patch::SetProp { value, name, .. } = p {
            println!("\nFound SetProp: name='{}', value={:?}", name, value);
            value == &json!("Alice")
        } else {
            false
        }
    });

    println!("\nHas Alice in SetProp: {}", has_alice);
}

#[test]
fn debug_simple_render_without_binding() {
    // GIVEN: Simple static element
    let mut engine = Engine::new();
    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // WHEN: Render static element
    let element = text_element("Hello");
    engine.render(&element);

    // THEN: Print patches
    let captured = patches.lock().unwrap();
    println!("\n=== Static element patches ({}) ===", captured.len());
    for (i, patch) in captured.iter().enumerate() {
        println!("[{}] {:?}", i, patch);
    }
}

#[test]
fn debug_binding_creation() {
    // Check what text_element_with_binding creates
    let element = text_element_with_binding("user.name");

    println!("\n=== Binding element structure ===");
    println!("Element type: {}", element.element_type);
    println!("Props count: {}", element.props.len());

    for (key, value) in &element.props {
        println!("  Prop '{}': {:?}", key, value);

        if let hypen_engine::ir::Value::Binding(binding) = value {
            println!("    Binding path: {:?}", binding.path);
            println!("    Full path: {}", binding.full_path());
        }
    }
}
