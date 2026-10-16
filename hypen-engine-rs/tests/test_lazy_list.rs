//! Engine-level list virtualization: `List`/`Grid` (lazy by default) and
//! `ForEach(…, lazy: true)` materialize only a window of items, report the
//! window through the `__virt.window` prop on the list element, and move it
//! on `set_list_viewport`.
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
    fn new(source: &str, state: Value) -> Self {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new("Test"), state));
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
    let h = Harness::new(LIST, json!({ "items": items(0..100) }));
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list), names(0..10));
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 100, "start": 0, "end": 10 }))
    );
}

#[test]
fn lazy_false_opts_a_list_out() {
    let h = Harness::new(
        r#"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#,
        json!({ "items": items(0..100) }),
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
    );
    let column = lazy.screen.find("Column");
    assert_eq!(lazy.screen.rows(&column), names(0..5));

    let eager = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
    );
    let column = eager.screen.find("Column");
    assert_eq!(eager.screen.rows(&column).len(), 50);

    // A sibling would share the parent's `__virt.window` — expand instead.
    let shared = Harness::new(
        r#"Column { Text("header") ForEach(items: @state.items, key: "id", lazy: true) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
    );
    let column = shared.screen.find("Column");
    assert_eq!(shared.screen.rows(&column).len(), 51);
    assert_eq!(shared.screen.window(&column), None);
}

#[test]
fn viewport_moves_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..20) }));
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
    let mut h = Harness::new(r#"Column { Text("x") }"#, json!({ "items": items(0..3) }));
    let column = h.screen.find("Column");
    assert!(h.viewport(&column, 0, 10).is_empty());
}

#[test]
fn edits_outside_the_window_emit_nothing() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    );
    let list = h.screen.find("List");
    assert_eq!(
        h.screen.window(&list),
        Some(json!({ "total": 5, "start": 0, "end": 2, "estimatedSize": 48.0 }))
    );
}

#[test]
fn hot_reload_to_lazy_false_expands_and_withdraws_the_window() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..30) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
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
    let mut h = Harness::new(ANIMATED_LIST, json!({ "items": items(0..100) }));
    let list = h.screen.find("List");
    let batch = h.viewport(&list, 5, 15);
    assert_eq!(removes(&batch), 5);
    assert_eq!(animated_removes(&batch), 0);
}

#[test]
fn deleted_rows_still_play_exit_transitions() {
    let mut h = Harness::new(ANIMATED_LIST, json!({ "items": items(0..100) }));
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
fn hot_reload_resends_a_changed_estimate() {
    let mut h = Harness::new(
        r#"List(@state.items, key: "id", initialCount: 5, estimatedItemSize: 40) { Text("@{item.name}") }"#,
        json!({ "items": items(0..50) }),
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
fn replacing_the_list_withdraws_the_window() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..50) }),
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
    );
    let error = h.screen.find("__Error");
    let message = h.screen.props[&error]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.contains("lazy"), "{message}");
}

// ── List sources and removal ─────────────────────────────────────────────
// Not lazy-specific, but the window code depends on them: a nested loop
// over the outer item, a data-source list, and removing a list that the
// renderer only sees through its rows.

fn all_texts(screen: &Screen) -> Vec<String> {
    let mut texts: Vec<String> = screen
        .props
        .values()
        .filter_map(|p| p.get("0").and_then(Value::as_str).map(String::from))
        .collect();
    texts.sort();
    texts
}

fn groups() -> Value {
    json!({ "groups": [
        { "id": 1, "name": "A", "children": [{ "id": 11, "name": "a1" }, { "id": 12, "name": "a2" }] },
        { "id": 2, "name": "B", "children": [{ "id": 21, "name": "b1" }] },
    ]})
}

#[test]
fn nested_loop_over_the_outer_item_renders() {
    for source in [
        // `@item.children`: an item binding.
        r#"Column { ForEach(items: @state.groups, key: "id") { Column { Text("@{item.name}") ForEach(items: @item.children, as: "child", key: "id") { Text("@{child.name}") } } } }"#,
        // `@g.children` under `as: "g"` parses as a provider named `g`.
        r#"Column { ForEach(items: @state.groups, as: "g", key: "id") { Column { Text("@{g.name}") ForEach(items: @g.children, as: "child", key: "id") { Text("@{child.name}") } } } }"#,
    ] {
        let h = Harness::new(source, groups());
        assert_eq!(
            all_texts(&h.screen),
            ["A", "B", "a1", "a2", "b1"],
            "{source}"
        );
    }
}

#[test]
fn inner_loop_reusing_the_name_shadows_the_outer_item() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.groups, key: "id") { Column { Text("@{item.name}") ForEach(items: @item.children, key: "id") { Text("@{item.name}") } } } }"#,
        groups(),
    );
    assert_eq!(all_texts(&h.screen), ["A", "B", "a1", "a2", "b1"]);
}

#[test]
fn nested_loop_follows_the_outer_item() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.groups, as: "g", key: "id") { Column { Text("@{g.name}") ForEach(items: @g.children, as: "c", key: "id") { Text("@{c.name}") } } } }"#,
        json!({ "groups": [{ "id": 1, "name": "A", "children": [{ "id": 11, "name": "a1" }] }] }),
    );
    h.engine.update_state(
        None,
        json!({ "groups": [{ "id": 1, "name": "A", "children": [{ "id": 11, "name": "a1" }, { "id": 12, "name": "a2" }] }] }),
    );
    h.flush();
    assert_eq!(all_texts(&h.screen), ["A", "a1", "a2"]);

    h.engine.update_state_sparse(
        None,
        &["groups.0.children.0.name".to_string()],
        &json!({ "groups.0.children.0.name": "a1!" }),
    );
    h.flush();
    assert_eq!(all_texts(&h.screen), ["A", "a1!", "a2"]);
}

#[test]
fn nested_lazy_list_windows_inside_a_row() {
    let children: Vec<Value> = (0..40)
        .map(|i| json!({ "id": i, "name": format!("row {i}") }))
        .collect();
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.groups, as: "g", key: "id") { Row { ForEach(items: @g.children, as: "c", key: "id", lazy: true, initialCount: 5) { Text("@{c.name}") } } } }"#,
        json!({ "groups": [{ "id": 1, "children": children }] }),
    );
    let row = h.screen.find("Row");
    assert_eq!(h.screen.rows(&row), names(0..5));
    h.viewport(&row, 20, 25);
    assert_eq!(h.screen.rows(&row), names(20..25));
}

#[test]
fn data_source_list_renders_and_updates() {
    let mut h = Harness::new(r#"Column { Text("x") }"#, json!({}));
    let messages = |n: usize| {
        Value::Array(
            (0..n)
                .map(|i| json!({ "id": i, "name": format!("row {i}") }))
                .collect(),
        )
    };
    h.engine
        .set_context("spacetime", json!({ "messages": messages(50) }));
    h.flush();
    h.render(r#"List(@spacetime.messages, key: "id", initialCount: 5) { Text("@{item.name}") }"#);
    let list = h.screen.find("List");
    assert_eq!(h.screen.rows(&list), names(0..5));

    h.engine
        .set_context("spacetime", json!({ "messages": messages(60) }));
    h.flush();
    assert_eq!(h.screen.window(&list).unwrap()["total"], json!(60));
    h.viewport(&list, 55, 60);
    assert_eq!(h.screen.rows(&list), names(55..60));
}

#[test]
fn replacing_a_loop_removes_its_rows() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
        json!({ "items": items(0..5) }),
    );
    let column = h.screen.find("Column");
    // Child 0 changes from a ForEach to a Text: the old rows must go, not
    // linger beside the re-created list.
    h.render(
        r#"Column { Text("header") ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
    );
    let mut expected = vec!["header".to_string()];
    expected.extend(names(0..5));
    assert_eq!(h.screen.rows(&column), expected);
}

#[test]
fn deleting_a_row_rooted_at_an_if_removes_its_content() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { If(@item.show) { Text("@{item.name}") } } }"#,
        json!({ "items": [
            { "id": 1, "name": "one", "show": true },
            { "id": 2, "name": "two", "show": true },
        ]}),
    );
    let column = h.screen.find("Column");
    assert_eq!(h.screen.rows(&column), ["one", "two"]);
    h.set_items(json!([{ "id": 2, "name": "two", "show": true }]));
    assert_eq!(h.screen.rows(&column), ["two"]);
}

// ── Review regressions ───────────────────────────────────────────────────

#[test]
fn hot_reload_turning_the_sole_child_into_a_lazy_list_windows_it() {
    let mut h = Harness::new(
        r#"Column { Text("loading") }"#,
        json!({ "items": items(0..50) }),
    );
    let column = h.screen.find("Column");
    h.render(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
    );
    assert_eq!(h.screen.rows(&column), names(0..5));
    assert_eq!(
        h.screen.window(&column),
        Some(json!({ "total": 50, "start": 0, "end": 5 }))
    );
}

#[test]
fn doubly_nested_loop_reads_the_outermost_item() {
    // `@item.children` in the innermost loop names the outermost row (the
    // middle loop is `as: "t"`), like every other `@item.*` binding there.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.groups, key: "id") { Column { ForEach(items: @state.tags, as: "t", key: "id") { Column { Text("@{t.name}") ForEach(items: @item.children, as: "c", key: "id") { Text("@{c.name}") } } } } } }"#,
        json!({
            "groups": [{ "id": 1, "children": [{ "id": 11, "name": "a1" }] }],
            "tags": [{ "id": 7, "name": "T", "children": [{ "id": 99, "name": "wrong" }] }],
        }),
    );
    assert_eq!(all_texts(&h.screen), ["T", "a1"]);
}

#[test]
fn removing_a_router_releases_its_cached_routes() {
    let mut h = Harness::new(
        r#"Column { If(@state.show) { Router { Route(path: "/a") { Text("@{state.label}") } Route(path: "/b") { Text("b") } } } }"#,
        json!({ "show": true, "location": "/a", "label": "one" }),
    );
    h.engine.update_state(None, json!({ "location": "/b" }));
    h.flush();
    h.engine.update_state(None, json!({ "show": false }));
    h.flush();
    // The cached `/a` subtree is gone from the renderer; it must not keep
    // receiving patches through its old bindings.
    h.engine.update_state(None, json!({ "label": "two" }));
    assert!(h.flush().is_empty());
}

#[test]
fn hot_reloaded_row_template_survives_a_viewport_report() {
    let mut h = Harness::new(LIST, json!({ "items": items(0..100) }));
    let list = h.screen.find("List");
    h.render(r#"List(@state.items, key: "id", initialCount: 10) { Text("n@{item.id}") }"#);
    assert_eq!(h.screen.rows(&list)[0], "n0");
    h.viewport(&list, 20, 30);
    assert_eq!(h.screen.rows(&list)[0], "n20");
}

#[test]
fn hot_reloaded_row_template_survives_a_state_update() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
        json!({ "items": items(0..3) }),
    );
    let column = h.screen.find("Column");
    h.render(r#"Column { ForEach(items: @state.items, key: "id") { Text("n@{item.id}") } }"#);
    h.set_items(items(0..4));
    assert_eq!(h.screen.rows(&column), ["n0", "n1", "n2", "n3"]);
}

#[test]
fn gaining_a_sibling_expands_the_list() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
        json!({ "items": items(0..20) }),
    );
    let column = h.screen.find("Column");
    h.render(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } Text("footer") }"#,
    );
    // Every row, and no window. (Order is not asserted: rows created after
    // a sibling exists are appended behind it — a general control-flow
    // placement limitation, not a windowing one.)
    let mut rows = h.screen.rows(&column);
    rows.sort();
    let mut expected = names(0..20);
    expected.push("footer".into());
    expected.sort();
    assert_eq!(rows, expected);
    assert_eq!(h.screen.window(&column), None);
}

#[test]
fn losing_a_sibling_windows_the_list() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } Text("footer") }"#,
        json!({ "items": items(0..20) }),
    );
    let column = h.screen.find("Column");
    h.render(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 5) { Text("@{item.name}") } }"#,
    );
    assert_eq!(h.screen.rows(&column), names(0..5));
    assert_eq!(
        h.screen.window(&column),
        Some(json!({ "total": 20, "start": 0, "end": 5 }))
    );
}
