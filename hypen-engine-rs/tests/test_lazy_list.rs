//! Engine-level list virtualization: `List`/`Grid` (lazy by default) and
//! `ForEach(…, lazy: true)` materialize only a window of items once the
//! renderer opts in with `set_virtualization`, report the window through the
//! `__virt.window` prop on the list element, and move it on
//! `set_list_viewport`.
//!
//! Every test drives patches into a tiny renderer model and asserts on what a
//! renderer would actually show, so ordering bugs (Insert/Move against the
//! window) surface as wrong row text rather than passing silently.

use hypen_engine::{
    ir::{ast_to_ir_node, NodeId},
    lifecycle::{Module, ModuleInstance},
    reconcile::Patch,
    Engine, TemplateExpander,
};
use hypen_parser::parse_component;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Minimal renderer: applies the plain (template-expanded) patch stream.
#[derive(Default)]
struct Screen {
    props: HashMap<String, HashMap<String, Value>>,
    types: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    roots: Vec<String>,
}

impl Screen {
    fn apply(&mut self, patches: &[Patch]) {
        for patch in patches {
            match patch {
                Patch::Create {
                    id,
                    element_type,
                    props,
                    ..
                } => {
                    self.types.insert(id.to_string(), element_type.clone());
                    self.props.insert(
                        id.to_string(),
                        props.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                    );
                }
                Patch::SetProp { id, name, value } => {
                    self.props
                        .entry(id.to_string())
                        .or_default()
                        .insert(name.clone(), value.clone());
                }
                Patch::RemoveProp { id, name } => {
                    if let Some(p) = self.props.get_mut(&id.to_string()) {
                        p.remove(name);
                    }
                }
                Patch::Insert {
                    parent_id,
                    id,
                    before_id,
                }
                | Patch::Move {
                    parent_id,
                    id,
                    before_id,
                } => {
                    let id = id.to_string();
                    for list in self.children.values_mut() {
                        list.retain(|c| *c != id);
                    }
                    self.roots.retain(|c| *c != id);
                    let list = if &**parent_id == "root" {
                        &mut self.roots
                    } else {
                        self.children.entry(parent_id.to_string()).or_default()
                    };
                    let at = before_id
                        .as_ref()
                        .and_then(|b| list.iter().position(|c| c.as_str() == &**b))
                        .unwrap_or(list.len());
                    list.insert(at, id);
                }
                Patch::Remove { id, .. } => {
                    let id = id.to_string();
                    for list in self.children.values_mut() {
                        list.retain(|c| *c != id);
                    }
                    self.props.remove(&id);
                    self.types.remove(&id);
                    self.children.remove(&id);
                }
                _ => {}
            }
        }
    }

    fn find(&self, element_type: &str) -> String {
        self.types
            .iter()
            .find(|(_, t)| t.as_str() == element_type)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| panic!("no {element_type} on screen"))
    }

    /// The `"0"` prop (Text content) of every row under `parent`, in order.
    fn rows(&self, parent: &str) -> Vec<String> {
        self.children
            .get(parent)
            .map(|ids| {
                ids.iter()
                    .map(|id| {
                        self.props[id]
                            .get("0")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn window(&self, list: &str) -> Option<Value> {
        self.props.get(list)?.get("__virt.window").cloned()
    }
}

struct Harness {
    engine: Engine,
    sink: Arc<Mutex<Vec<Patch>>>,
    expander: TemplateExpander,
    screen: Screen,
}

impl Harness {
    fn new(source: &str, state: Value, virtualization: bool) -> Self {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new("Test"), state));
        engine.set_virtualization(virtualization);
        let sink: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&sink);
        engine.set_render_callback(move |patches| out.lock().unwrap().extend_from_slice(patches));
        let mut harness = Self {
            engine,
            sink,
            expander: TemplateExpander::new(),
            screen: Screen::default(),
        };
        harness.render(source);
        harness
    }

    fn render(&mut self, source: &str) {
        let ir = ast_to_ir_node(&parse_component(source).unwrap());
        self.engine.render_ir_node(&ir);
        self.flush();
    }

    /// Apply everything emitted since the last flush; returns the batch.
    fn flush(&mut self) -> Vec<Patch> {
        let raw = std::mem::take(&mut *self.sink.lock().unwrap());
        let batch = self.expander.expand(raw);
        self.screen.apply(&batch);
        batch
    }

    fn viewport(&mut self, list: &str, start: usize, end: usize) -> Vec<Patch> {
        let id: NodeId = parse_id(list);
        self.engine.set_list_viewport(id, start, end);
        self.flush()
    }

    fn set_items(&mut self, items: Value) -> Vec<Patch> {
        self.engine.update_state(None, json!({ "items": items }));
        self.flush()
    }
}

fn parse_id(id: &str) -> NodeId {
    NodeId::from(slotmap::KeyData::from_ffi(id.parse::<u64>().unwrap()))
}

fn items(range: std::ops::Range<usize>) -> Value {
    Value::Array(
        range
            .map(|i| json!({ "id": i, "name": format!("row {i}") }))
            .collect(),
    )
}

fn names(range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|i| format!("row {i}")).collect()
}

fn creates(batch: &[Patch]) -> usize {
    batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count()
}

fn removes(batch: &[Patch]) -> usize {
    batch
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .count()
}

const LIST: &str = r#"List(@state.items, key: "id", initialCount: 10) { Text("@{item.name}") }"#;

#[test]
fn list_materializes_only_the_initial_window() {
    let h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list), names(0..10));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 100, "start": 0, "end": 10 }))
    );
}

#[test]
fn without_virtualization_the_list_expands_fully() {
    let h = Harness::new(LIST, json!({ "items": items(0..100) }), false);
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list).len(), 100);
    assert_eq!(h.screen.window(&list), None);
}

#[test]
fn lazy_false_opts_a_list_out() {
    let h = Harness::new(
        r#"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#,
        json!({ "items": items(0..100) }),
        true,
    );
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list).len(), 100);
    assert_eq!(h.screen.window(&list), None);
    // The arg is consumed, not passed to the renderer as `lazy.0`.
    assert!(!h.screen.props[&list].contains_key("lazy.0"));
}

#[test]
fn foreach_is_lazy_only_when_asked_and_alone() {
    let lazy = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let column = lazy.screen.find("Column");
    assert_eq!(lazy.screen.rows(&column), names(0..5));

    let eager = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let column = eager.screen.find("Column");
    assert_eq!(eager.screen.rows(&column).len(), 50);

    // A sibling would share the parent's `__virt.window` — expand instead.
    let shared = Harness::new(
        r#"Column { Text("header") ForEach(items: @state.items, key: "id", lazy: true) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let column = shared.screen.find("Column");
    assert_eq!(shared.screen.rows(&column).len(), 51);
    assert_eq!(shared.screen.window(&column), None);
}

#[test]
fn viewport_moves_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");

    let batch = h.viewport(&list, 40, 55);
    assert_eq!(h.screen.rows(&list), names(40..55));
    assert_eq!(creates(&batch), 15);
    assert_eq!(removes(&batch), 10);
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 100, "start": 40, "end": 55 }))
    );

    // Overlapping scroll: only the delta is created/removed.
    let batch = h.viewport(&list, 45, 60);
    assert_eq!(h.screen.rows(&list), names(45..60));
    assert_eq!(creates(&batch), 5);
    assert_eq!(removes(&batch), 5);

    // Scrolling back up inserts rows before the survivors.
    h.viewport(&list, 42, 57);
    assert_eq!(h.screen.rows(&list), names(42..57));

    // Same range again: nothing to do.
    assert!(h.viewport(&list, 42, 57).is_empty());
}

#[test]
fn viewport_past_the_end_is_clamped() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..20) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 15, 40);
    assert_eq!(h.screen.rows(&list), names(15..20));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 20, "start": 15, "end": 20 }))
    );
}

#[test]
fn viewport_on_a_non_list_element_is_ignored() {
    let mut h = Harness::new(
        r#"Column { Text("x") }"#,
        json!({ "items": items(0..3) }),
        true,
    );
    let column = h.screen.find("Column");
    assert!(h.viewport(&column, 0, 10).is_empty());
}

#[test]
fn edits_outside_the_window_emit_nothing() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");

    h.engine.update_state_sparse(
        None,
        &["items.80.name".to_string()],
        &json!({ "items.80.name": "edited" }),
    );
    assert!(h.flush().is_empty());

    h.engine.update_state_sparse(
        None,
        &["items.3.name".to_string()],
        &json!({ "items.3.name": "edited" }),
    );
    let batch = h.flush();
    assert_eq!(creates(&batch) + removes(&batch), 0);
    assert_eq!(h.screen.rows(&list)[3], "edited");
}

#[test]
fn inserting_above_the_window_keeps_the_visible_rows() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 40, 50);

    // Prepend five new items: the window follows its anchor (row 40), so the
    // same rows stay materialized and only `__virt.window` changes.
    let mut prepended: Vec<Value> = (1000..1005)
        .map(|i| json!({ "id": i, "name": format!("new {i}") }))
        .collect();
    prepended.extend(items(0..100).as_array().unwrap().iter().cloned());
    let batch = h.set_items(Value::Array(prepended));

    assert_eq!(creates(&batch) + removes(&batch), 0);
    assert_eq!(h.screen.rows(&list), names(40..50));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 105, "start": 45, "end": 55 }))
    );
}

#[test]
fn appending_updates_total_without_touching_rows() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    let batch = h.set_items(items(0..150));
    assert_eq!(creates(&batch) + removes(&batch), 0);
    assert_eq!(h.screen.rows(&list), names(0..10));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 150, "start": 0, "end": 10 }))
    );
}

#[test]
fn shrinking_below_the_window_shows_the_tail() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 80, 90);
    h.set_items(items(0..30));
    assert_eq!(h.screen.rows(&list), names(20..30));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 30, "start": 20, "end": 30 }))
    );
}

#[test]
fn removing_the_anchor_keeps_the_window_position() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 40, 50);
    let without_40: Vec<Value> = items(0..100)
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["id"] != 40)
        .cloned()
        .collect();
    h.set_items(Value::Array(without_40));
    let expected: Vec<String> = names(41..51);
    assert_eq!(h.screen.rows(&list), expected);
}

#[test]
fn unkeyed_lazy_list_windows_by_index() {
    // No `id` and no `key:` — rows are keyed by index (`item-<idx>`).
    let unkeyed = |range: std::ops::Range<usize>| {
        Value::Array(
            range
                .map(|i| json!({ "name": format!("row {i}") }))
                .collect(),
        )
    };
    let mut h = Harness::new(
        r#"List(@state.items, initialCount: 4) { Text("@{item.name}") }"#,
        json!({ "items": unkeyed(0..20) }),
        true,
    );
    let list = h.screen.find("List");
    h.viewport(&list, 8, 12);
    assert_eq!(h.screen.rows(&list), names(8..12));

    // Index identity can't follow a prepend: the window stays on indices
    // 8..12, which now hold rows 7..11.
    let mut prepended = vec![json!({ "name": "new" })];
    prepended.extend(unkeyed(0..20).as_array().unwrap().iter().cloned());
    h.set_items(Value::Array(prepended));
    assert_eq!(h.screen.rows(&list), names(7..11));
}

#[test]
fn multi_template_rows_window_together() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 3) { Text("@{item.name}") Text("—") } }"#,
        json!({ "items": items(0..20) }),
        true,
    );
    let column = h.screen.find("Column");
    assert_eq!(h.screen.rows(&column).len(), 6);
    h.viewport(&column, 10, 12);
    assert_eq!(h.screen.rows(&column), vec!["row 10", "—", "row 11", "—"]);
}

#[test]
fn estimated_item_size_is_forwarded() {
    let h = Harness::new(
        r#"List(@state.items, key: "id", initialCount: 2, estimatedItemSize: 48) { Text("@{item.name}") }"#,
        json!({ "items": items(0..5) }),
        true,
    );
    let list = h.screen.find("List");
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 5, "start": 0, "end": 2, "estimatedSize": 48.0 }))
    );
}

#[test]
fn hot_reload_to_lazy_false_expands_and_withdraws_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..30) }), true);
    let list = h.screen.find("List");
    h.render(r#"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#);
    assert_eq!(h.screen.rows(&list), names(0..30));
    assert_eq!(h.screen.window(&list), None);
}

#[test]
fn grid_is_lazy_by_default() {
    let h = Harness::new(
        r#"Grid(@state.items, key: "id", columns: 3, initialCount: 9) { Text("@{item.name}") }"#,
        json!({ "items": items(0..90) }),
        true,
    );
    let grid = h.screen.find("Grid");
    assert_eq!(h.screen.rows(&grid), names(0..9));
}

fn animated_removes(batch: &[Patch]) -> usize {
    batch
        .iter()
        .filter(|p| {
            matches!(
                p,
                Patch::Remove {
                    transition: true,
                    ..
                }
            )
        })
        .count()
}

fn with_prepended(extra: Vec<Value>, base: Value) -> Value {
    let mut all = extra;
    all.extend(base.as_array().unwrap().iter().cloned());
    Value::Array(all)
}

#[test]
fn viewport_on_an_eager_list_or_bad_id_is_ignored() {
    let mut h = Harness::new(
        r#"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#,
        json!({ "items": items(0..20) }),
        true,
    );
    let list = h.screen.find("List");
    assert!(h.viewport(&list, 5, 10).is_empty());
    assert_eq!(h.screen.rows(&list).len(), 20);
    // Unknown id: no patches, no panic.
    h.engine.set_list_viewport(parse_id("123456789"), 0, 10);
    assert!(h.flush().is_empty());
}

#[test]
fn huge_viewport_end_does_not_overflow() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 5, usize::MAX);
    assert_eq!(h.screen.rows(&list), names(5..100));
    // The next shift used to overflow `start + count`.
    h.set_items(with_prepended(
        vec![json!({ "id": 999, "name": "new" })],
        items(0..100),
    ));
    assert_eq!(h.screen.rows(&list), names(5..100));
}

#[test]
fn moving_the_top_row_away_keeps_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 40, 50);
    // Sort row 40 to the bottom: the window stays with its neighbours
    // instead of following row 40 and collapsing to one row.
    let mut moved: Vec<Value> = items(0..100)
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["id"] != 40)
        .cloned()
        .collect();
    moved.push(json!({ "id": 40, "name": "row 40" }));
    h.set_items(Value::Array(moved));
    assert_eq!(h.screen.rows(&list), names(41..51));
}

#[test]
fn duplicate_key_above_does_not_capture_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 40, 50);
    h.set_items(with_prepended(
        vec![json!({ "id": 40, "name": "dup" })],
        items(0..100),
    ));
    assert_eq!(h.screen.rows(&list), names(40..50));
}

const ANIMATED_LIST: &str =
    r#"List(@state.items, key: "id", initialCount: 10) { Text("@{item.name}").exit(fade) }"#;

#[test]
fn rows_scrolled_out_do_not_play_exit_transitions() {
    let mut h = Harness::new(ANIMATED_LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    let batch = h.viewport(&list, 5, 15);
    assert_eq!(removes(&batch), 5);
    assert_eq!(animated_removes(&batch), 0);
}

#[test]
fn deleted_rows_still_play_exit_transitions() {
    let mut h = Harness::new(ANIMATED_LIST, json!({ "items": items(0..100) }), true);
    let list = h.screen.find("List");
    h.viewport(&list, 0, 10);
    // Delete visible row 3 and prepend one: row 9 is pushed out of the
    // window (an eviction), row 3 is gone from the data (an exit).
    let mut next: Vec<Value> = vec![json!({ "id": 500, "name": "new" })];
    next.extend(
        items(0..100)
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["id"] != 3)
            .cloned(),
    );
    let batch = h.set_items(Value::Array(next));
    assert_eq!(animated_removes(&batch), 1);
    assert!(!h.screen.rows(&list).contains(&"row 3".to_string()));
}

#[test]
fn hot_reload_to_lazy_windows_an_expanded_list() {
    let mut h = Harness::new(
        r#"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#,
        json!({ "items": items(0..30) }),
        true,
    );
    let list = h.screen.find("List");
    h.render(LIST);
    assert_eq!(h.screen.rows(&list), names(0..10));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 30, "start": 0, "end": 10 }))
    );
}

#[test]
fn toggling_virtualization_applies_on_the_next_update() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..30) }), false);
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list).len(), 30);

    h.engine.set_virtualization(true);
    h.set_items(items(0..31));
    assert_eq!(h.screen.rows(&list), names(0..10));

    h.engine.set_virtualization(false);
    h.set_items(items(0..32));
    assert_eq!(h.screen.rows(&list).len(), 32);
    assert_eq!(h.screen.window(&list), None);
}

#[test]
fn hot_reload_resends_a_changed_estimate() {
    let mut h = Harness::new(
        r#"List(@state.items, key: "id", initialCount: 5, estimatedItemSize: 40) { Text("@{item.name}") }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let list = h.screen.find("List");
    h.render(
        r#"List(@state.items, key: "id", initialCount: 5, estimatedItemSize: 80) { Text("@{item.name}") }"#,
    );
    assert_eq!(
        h.screen.window(&list).unwrap()["estimatedSize"],
        json!(80.0)
    );
}

#[test]
fn gaining_a_sibling_withdraws_the_window() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let column = h.screen.find("Column");
    assert!(h.screen.window(&column).is_some());
    h.render(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } Text("footer") }"#,
    );
    assert_eq!(h.screen.window(&column), None);
}

#[test]
fn replacing_the_list_withdraws_the_window() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
        true,
    );
    let column = h.screen.find("Column");
    h.render(r#"Column { Text("empty") }"#);
    assert_eq!(h.screen.window(&column), None);
}

#[test]
fn bound_lazy_flag_is_an_error() {
    let h = Harness::new(
        r#"List(@state.items, key: "id", lazy: @state.flag) { Text("@{item.name}") }"#,
        json!({ "items": items(0..5), "flag": true }),
        true,
    );
    let error = h.screen.find("__Error");
    let message = h.screen.props[&error]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.contains("lazy"), "{message}");
}
