//! Benchmarks for state cloning performance
//!
//! Run with: cargo bench --bench state_clone

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use serde_json::json;

/// Create a state object of varying sizes
fn create_state(num_keys: usize, array_size: usize, string_len: usize) -> serde_json::Value {
    let mut obj = serde_json::Map::new();

    // Add simple key-value pairs
    for i in 0..num_keys {
        obj.insert(format!("key_{}", i), json!("x".repeat(string_len)));
    }

    // Add an array
    let items: Vec<serde_json::Value> = (0..array_size)
        .map(|i| {
            json!({
                "id": i,
                "name": format!("Item {}", i),
                "description": "x".repeat(string_len),
                "tags": ["tag1", "tag2", "tag3"],
            })
        })
        .collect();
    obj.insert("items".to_string(), json!(items));

    // Add a counter
    obj.insert("counter".to_string(), json!(0));

    serde_json::Value::Object(obj)
}

fn bench_state_clone(c: &mut Criterion) {
    let mut group = c.benchmark_group("state_clone");

    // Test different state sizes
    let configs = [
        ("tiny", 5, 5, 10),       // ~500 bytes
        ("small", 20, 20, 50),    // ~10KB
        ("medium", 50, 50, 100),  // ~50KB
        ("large", 100, 100, 200), // ~200KB
    ];

    for (name, num_keys, array_size, string_len) in configs {
        let state = create_state(num_keys, array_size, string_len);
        let size = serde_json::to_string(&state).unwrap().len();

        group.throughput(Throughput::Bytes(size as u64));
        group.bench_with_input(BenchmarkId::new("deep_clone", name), &state, |b, state| {
            b.iter(|| {
                let cloned = black_box(state.clone());
                black_box(cloned)
            });
        });
    }

    group.finish();
}

fn bench_state_arc_clone(c: &mut Criterion) {
    use std::sync::Arc;

    let mut group = c.benchmark_group("state_arc_clone");

    let configs = [
        ("tiny", 5, 5, 10),
        ("small", 20, 20, 50),
        ("medium", 50, 50, 100),
        ("large", 100, 100, 200),
    ];

    for (name, num_keys, array_size, string_len) in configs {
        let state = Arc::new(create_state(num_keys, array_size, string_len));
        let size = serde_json::to_string(&*state).unwrap().len();

        group.throughput(Throughput::Bytes(size as u64));
        group.bench_with_input(BenchmarkId::new("arc_clone", name), &state, |b, state| {
            b.iter(|| {
                let cloned = black_box(Arc::clone(state));
                black_box(cloned)
            });
        });
    }

    group.finish();
}

fn bench_state_access_patterns(c: &mut Criterion) {
    use std::sync::Arc;

    let mut group = c.benchmark_group("state_access");

    let state = create_state(50, 50, 100);
    let arc_state = Arc::new(state.clone());

    // Simulate the hot path: clone state for render
    group.bench_function("owned_clone_for_render", |b| {
        b.iter(|| {
            let cloned = black_box(state.clone());
            // Simulate accessing a value
            let _ = black_box(cloned.get("counter"));
        });
    });

    group.bench_function("arc_clone_for_render", |b| {
        b.iter(|| {
            let cloned = black_box(Arc::clone(&arc_state));
            // Simulate accessing a value
            let _ = black_box(cloned.get("counter"));
        });
    });

    // Simulate read-only access (no clone needed with borrow)
    group.bench_function("borrow_for_read", |b| {
        b.iter(|| {
            let borrowed = black_box(&state);
            let _ = black_box(borrowed.get("counter"));
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_state_clone,
    bench_state_arc_clone,
    bench_state_access_patterns
);
criterion_main!(benches);
