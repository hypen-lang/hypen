//! Native timing harness for the react-vs-hypen list scenarios: how long
//! the engine itself takes (state apply → reconcile → patches → JSON)
//! without any WASM boundary or renderer in the way.
//!
//!   cargo run --release --example bench_create -- path/to/template.hypen

use hypen_engine::{ast_to_ir_node, Engine, ModuleInstance, Patch};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const TEAMS: [&str; 3] = ["core", "edge", "data"];

fn rows(n: usize, salt: usize) -> serde_json::Value {
    let statuses = ["healthy", "degraded", "down", "queued"];
    let colors = ["#22c55e", "#f59e0b", "#ef4444", "#3b82f6"];
    serde_json::Value::Array(
        (0..n)
            .map(|i| {
                let s = (i + salt) % 4;
                json!({
                    "id": i + salt * 100_000,
                    "name": format!("brisk falcon #{}", i + salt),
                    "initials": "BF",
                    "team": TEAMS[i % 3],
                    "meta": format!("{}m ago", 1 + (i * 7 + salt) % 48),
                    "status": statuses[s],
                    "statusColor": colors[s],
                    "value": format!("{} ops/s", 100 + (i * 37 + salt) % 900),
                    "selected": false,
                })
            })
            .collect(),
    )
}

#[derive(Default)]
struct Sink {
    patches: usize,
    json_bytes: usize,
    serialize_ms: f64,
    /// `BENCH_DUMP=<path>`: every render's serialized patch list is appended
    /// here (one JSON document per line, in emission order), so two builds
    /// can be checked for byte-identical wire output with a plain `diff`.
    dump: Option<std::fs::File>,
}

fn main() {
    let path = std::env::args().nth(1).expect("template path");
    let src = std::fs::read_to_string(&path).expect("read template");
    let doc = hypen_parser::parse_document(&src).expect("parse");
    let ir = ast_to_ir_node(doc.components.first().expect("component"));

    let sink = Arc::new(Mutex::new(Sink {
        dump: std::env::var("BENCH_DUMP")
            .ok()
            .map(|p| std::fs::File::create(p).expect("create BENCH_DUMP file")),
        ..Sink::default()
    }));
    let mut engine = Engine::new();
    engine
        .component_registry_mut()
        .register_default_primitives();
    {
        let sink = Arc::clone(&sink);
        engine.set_render_callback(move |patches: &[Patch]| {
            let t = Instant::now();
            let s = serde_json::to_string(patches).expect("serialize");
            let mut g = sink.lock().unwrap();
            g.patches = patches.len();
            g.json_bytes = s.len();
            g.serialize_ms = t.elapsed().as_secs_f64() * 1e3;
            if let Some(f) = g.dump.as_mut() {
                use std::io::Write;
                writeln!(f, "{s}").expect("write BENCH_DUMP");
            }
        });
    }
    engine.set_module(ModuleInstance::from_config(
        "bench",
        vec![],
        vec!["rows".into()],
        json!({ "rows": [] }),
    ));

    let t = Instant::now();
    engine.render_ir_node(&ir);
    println!(
        "initial render (empty list): {:.1} ms",
        t.elapsed().as_secs_f64() * 1e3
    );

    let rows_path = vec!["rows".to_string()];
    // BENCH_ONLY=<substring> skips the timing/printing of every other step
    // (the state transitions still run so later steps see the right tree),
    // which keeps a callgrind run attributable to one scenario.
    let only = std::env::var("BENCH_ONLY").ok();
    let mut step = |label: &str, paths: &[String], values: serde_json::Value| {
        if let Some(f) = &only {
            if !label.contains(f.as_str()) {
                engine.update_state_sparse(None, paths, &values);
                return;
            }
        }
        let t = Instant::now();
        engine.update_state_sparse(None, paths, &values);
        let total = t.elapsed().as_secs_f64() * 1e3;
        let g = sink.lock().unwrap();
        println!(
            "{label:<14} total {total:>7.1} ms   (patches {:>5}, json {:>6.0} KB, serialize {:>5.1} ms)",
            g.patches,
            g.json_bytes as f64 / 1024.0,
            g.serialize_ms
        );
    };

    step("create-1k", &rows_path, json!({ "rows": rows(1000, 0) }));
    step("clear", &rows_path, json!({ "rows": [] }));
    step("create-1k #2", &rows_path, json!({ "rows": rows(1000, 1) }));
    step("replace-1k", &rows_path, json!({ "rows": rows(1000, 2) }));
    step("append-1k", &rows_path, {
        let mut all = rows(1000, 2);
        all.as_array_mut()
            .unwrap()
            .extend(rows(1000, 3).as_array().unwrap().iter().cloned());
        json!({ "rows": all })
    });
    step("clear #2", &rows_path, json!({ "rows": [] }));
    step("create-1k #3", &rows_path, json!({ "rows": rows(1000, 4) }));

    // update-all: same ids, every name changes → 1000 leaf paths
    let paths: Vec<String> = (0..1000).map(|i| format!("rows.{i}.name")).collect();
    let mut values = serde_json::Map::new();
    for i in 0..1000 {
        values.insert(
            format!("rows.{i}.name"),
            json!(format!("updated name #{i}")),
        );
    }
    step("update-all", &paths, serde_json::Value::Object(values));

    step(
        "select-row",
        &["rows.500.selected".to_string()],
        json!({ "rows.500.selected": true }),
    );
}
