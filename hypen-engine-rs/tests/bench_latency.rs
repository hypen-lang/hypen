use hypen_engine::ir::{Element, Props, Value};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reactive::Binding;
use hypen_engine::Engine;
use serde_json::json;
use std::time::Instant;

fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} bytes", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn text_with_binding(path: &str) -> Element {
    let binding = Binding::state(path.split('.').map(String::from).collect());
    let mut props = Props::new();
    props.insert("text".to_string(), Value::Binding(binding));
    Element {
        element_type: "Text".to_string(),
        props,
        ir_children: Vec::new(),
        key: None, module_scope: None,
    }
}

fn column_with_children(children: Vec<Element>) -> Element {
    Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: children.into_iter().map(hypen_engine::ir::IRNode::Element).collect(),
        key: None, module_scope: None,
    }
}

fn measure_engine_update(
    name: &str,
    element: Element,
    initial_state: serde_json::Value,
    update_fn: impl Fn(&serde_json::Value, usize) -> serde_json::Value,
    iterations: usize,
) {
    let state_size = serde_json::to_string(&initial_state).unwrap().len();

    // Create engine with module
    let mut engine = Engine::new();
    let module_meta = Module::new("BenchModule");
    let module = ModuleInstance::new(module_meta, initial_state.clone());
    engine.set_module(module);

    // Initial render
    engine.render(&element);

    // Measure update + re-render latency
    let start = Instant::now();
    for i in 0..iterations {
        let new_state = update_fn(&initial_state, i);
        engine.update_state(None, new_state);
        // Force re-render to measure full cycle
        engine.render(&element);
    }
    let elapsed = start.elapsed();

    let latency_us = elapsed.as_micros() as f64 / iterations as f64;
    let updates_per_sec = 1_000_000.0 / latency_us;

    println!(
        "{:<25} {:>12} {:>12.0} {:>12.2}ms",
        name,
        format_bytes(state_size),
        updates_per_sec,
        latency_us / 1000.0
    );
}

#[test]
fn bench_update_latency() {
    println!("\n");
    println!("=================================================================");
    println!("        Update Latency Benchmarks (Full Engine Cycle)           ");
    println!("=================================================================");
    println!(
        "{:<25} {:>12} {:>12} {:>12}",
        "State Type", "Size", "Updates/sec", "Latency"
    );
    println!("{}", "-".repeat(65));

    // Counter (tiny state) - 15 bytes
    let counter_element = text_with_binding("count");
    let counter_state = json!({"count": 0});
    measure_engine_update(
        "Counter (tiny)",
        counter_element,
        counter_state,
        |_base, i| json!({"count": i}),
        20000,
    );

    // Medium state - ~7 KB with multiple bindings
    let medium_element = column_with_children(vec![
        text_with_binding("user.name"),
        text_with_binding("user.email"),
        text_with_binding("status"),
    ]);
    let medium_state = json!({
        "user": {
            "name": "Alice",
            "email": "alice@example.com",
            "profile": {
                "bio": "Software developer with 10 years of experience building web applications",
                "avatar": "https://example.com/avatars/alice.png",
                "location": "San Francisco, CA"
            }
        },
        "status": "online",
        "items": (0..100).map(|i| json!({
            "id": i,
            "name": format!("Item {} with a longer name", i),
            "price": i * 10 + 99,
            "description": format!("Description for item {}", i)
        })).collect::<Vec<_>>()
    });
    measure_engine_update(
        "Medium (~7 KB)",
        medium_element,
        medium_state,
        |_base, i| json!({"status": if i % 2 == 0 { "online" } else { "offline" }}),
        10000,
    );

    // Large state - ~77 KB
    let large_element = column_with_children(vec![
        text_with_binding("count"),
        text_with_binding("status"),
    ]);
    let large_state = json!({
        "count": 500,
        "status": "loaded",
        "users": (0..500).map(|i| json!({
            "id": i,
            "name": format!("User {} with full name", i),
            "email": format!("user{}@example.com", i),
            "profile": {
                "bio": format!("This is the biography for user {}. It contains several sentences of text.", i),
                "avatar": format!("https://cdn.example.com/avatars/user{}.png", i),
                "joinDate": "2024-01-15T10:30:00Z"
            }
        })).collect::<Vec<_>>()
    });
    measure_engine_update(
        "Large (~77 KB)",
        large_element,
        large_state,
        |_base, i| json!({"count": 500 + i}),
        2000,
    );

    // Very large state - ~567 KB
    let very_large_element = column_with_children(vec![text_with_binding("total")]);
    let very_large_state = json!({
        "total": 3000,
        "data": (0..3000).map(|i| json!({
            "id": i,
            "title": format!("Record {} - Important data item with longer title", i),
            "content": format!("This is the content for record {}. It includes multiple sentences to simulate real-world data payloads.", i),
            "metadata": {
                "created": "2024-01-01T00:00:00Z",
                "updated": "2024-01-15T12:30:00Z",
                "author": format!("Author {}", i % 50),
                "tags": ["tag1", "tag2", "tag3", "important"],
                "views": i * 100
            }
        })).collect::<Vec<_>>()
    });
    measure_engine_update(
        "Very Large (~567 KB)",
        very_large_element,
        very_large_state,
        |_base, i| json!({"total": 3000 + i}),
        500,
    );

    // 50 bindings
    let bindings_element = column_with_children(
        (0..50)
            .map(|i| text_with_binding(&format!("field{}", i)))
            .collect(),
    );
    let mut bindings_obj = serde_json::Map::new();
    for i in 0..50 {
        bindings_obj.insert(format!("field{}", i), json!(format!("value{}", i)));
    }
    let bindings_state = serde_json::Value::Object(bindings_obj);
    measure_engine_update(
        "50 bindings (~1 KB)",
        bindings_element,
        bindings_state,
        |_base, i| json!({"field0": format!("updated{}", i)}),
        10000,
    );

    println!("{}", "-".repeat(65));
    println!();
}
