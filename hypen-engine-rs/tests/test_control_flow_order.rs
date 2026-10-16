//! Control-flow content must keep its place among the parent's children.
//!
//! `ForEach` / `If` / `When` / `Router` are transparent to renderers: their
//! content is inserted straight into the nearest real element. Content they
//! create (or move) on a later pass therefore has to be anchored before the
//! first rendered node that FOLLOWS the control-flow node — appending it
//! (`before_id: None`) puts a new row after the list's footer.
//!
//! Every test drives the patch stream into a tiny renderer model and asserts
//! the parent's final child ORDER, then cross-checks the whole screen against
//! a fresh render of the same state (the order the engine itself would pick
//! from scratch).

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

/// Minimal renderer over the plain (template-expanded) patch stream.
#[derive(Default)]
struct Screen {
    props: HashMap<String, HashMap<String, Value>>,
    types: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    roots: Vec<String>,
}

impl Screen {
    fn unlink(&mut self, id: &str) {
        for list in self.children.values_mut() {
            list.retain(|c| c != id);
        }
        self.roots.retain(|c| c != id);
    }

    fn place(&mut self, parent_id: &str, id: &str, before_id: Option<&str>) {
        self.unlink(id);
        let list = if parent_id == "root" {
            &mut self.roots
        } else {
            assert!(
                self.types.contains_key(parent_id),
                "patch addresses parent {parent_id}, which the renderer never created"
            );
            self.children.entry(parent_id.to_string()).or_default()
        };
        let at = match before_id {
            Some(b) => list
                .iter()
                .position(|c| c == b)
                .unwrap_or_else(|| panic!("anchor {b} is not a child of {parent_id}")),
            None => list.len(),
        };
        list.insert(at, id.to_string());
    }

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
                }
                | Patch::Attach {
                    parent_id,
                    id,
                    before_id,
                } => {
                    assert!(
                        self.types.contains_key(&**id),
                        "patch places {id}, which the renderer never created"
                    );
                    self.place(parent_id, id, before_id.as_deref());
                }
                Patch::Detach { id } => {
                    assert!(
                        self.types.contains_key(&**id),
                        "detach of {id}, which the renderer never created"
                    );
                    self.unlink(id);
                }
                Patch::Remove { id, .. } => {
                    let id = id.to_string();
                    self.unlink(&id);
                    self.props.remove(&id);
                    self.types.remove(&id);
                    self.children.remove(&id);
                }
                _ => {}
            }
        }
    }

    fn find(&self, element_type: &str) -> String {
        let mut ids: Vec<&String> = self
            .types
            .iter()
            .filter(|(_, t)| t.as_str() == element_type)
            .map(|(id, _)| id)
            .collect();
        assert_eq!(ids.len(), 1, "expected exactly one {element_type}");
        ids.pop().unwrap().clone()
    }

    /// Text content (prop `"0"`) or, failing that, element type.
    fn label(&self, id: &str) -> String {
        self.props
            .get(id)
            .and_then(|p| p.get("0"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.types[id].clone())
    }

    /// Labels of `parent`'s children, in order.
    fn rows(&self, parent: &str) -> Vec<String> {
        self.children
            .get(parent)
            .map(|ids| ids.iter().map(|id| self.label(id)).collect())
            .unwrap_or_default()
    }

    /// Whole screen as a nested label string, ids elided — comparable
    /// across engines.
    fn snapshot(&self) -> String {
        fn walk(s: &Screen, id: &str, out: &mut String) {
            out.push_str(&s.label(id));
            if let Some(kids) = s.children.get(id).filter(|k| !k.is_empty()) {
                out.push('{');
                for (i, k) in kids.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    walk(s, k, out);
                }
                out.push('}');
            }
        }
        let mut out = String::new();
        for r in &self.roots {
            walk(self, r, &mut out);
        }
        out
    }
}

struct Harness {
    source: String,
    state: Value,
    engine: Engine,
    sink: Arc<Mutex<Vec<Patch>>>,
    expander: TemplateExpander,
    screen: Screen,
}

impl Harness {
    fn new(source: &str, state: Value) -> Self {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new("Test"), state.clone()));
        let sink: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&sink);
        engine.set_render_callback(move |patches| out.lock().unwrap().extend_from_slice(patches));
        let mut harness = Self {
            source: source.to_string(),
            state,
            engine,
            sink,
            expander: TemplateExpander::new(),
            screen: Screen::default(),
        };
        let ir = ast_to_ir_node(&parse_component(source).unwrap());
        harness.engine.render_ir_node(&ir);
        harness.flush();
        harness
    }

    fn flush(&mut self) {
        let raw = std::mem::take(&mut *self.sink.lock().unwrap());
        let batch = self.expander.expand(raw);
        self.screen.apply(&batch);
    }

    /// Merge `patch` into state, push it through the engine, then check the
    /// screen matches a from-scratch render of the merged state.
    fn update(&mut self, patch: Value) {
        if let (Value::Object(state), Value::Object(changes)) = (&mut self.state, &patch) {
            for (k, v) in changes {
                state.insert(k.clone(), v.clone());
            }
        }
        self.engine.update_state(None, patch);
        self.flush();
        self.assert_matches_fresh_render();
    }

    fn viewport(&mut self, parent: &str, start: usize, end: usize) {
        let id = NodeId::from(slotmap::KeyData::from_ffi(parent.parse::<u64>().unwrap()));
        self.engine.set_list_viewport(id, start, end);
        self.flush();
    }

    fn assert_matches_fresh_render(&self) {
        let fresh = Harness::new(&self.source, self.state.clone());
        assert_eq!(
            self.screen.snapshot(),
            fresh.screen.snapshot(),
            "incremental screen diverged from a fresh render"
        );
    }
}

fn items(names: &[&str]) -> Value {
    Value::Array(
        names
            .iter()
            .map(|n| json!({ "id": n, "name": n }))
            .collect(),
    )
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

const LIST_THEN_FOOTER: &str =
    r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } Text("footer") }"#;

// ---------------------------------------------------------------------------
// ForEach followed by a sibling
// ---------------------------------------------------------------------------

#[test]
fn foreach_append_lands_before_following_sibling() {
    let mut h = Harness::new(LIST_THEN_FOOTER, json!({ "items": items(&["a", "b"]) }));
    let col = h.screen.find("Column");
    h.update(json!({ "items": items(&["a", "b", "c"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "c", "footer"]));
}

#[test]
fn foreach_prepend_and_middle_insert_keep_order() {
    let mut h = Harness::new(LIST_THEN_FOOTER, json!({ "items": items(&["b", "d"]) }));
    let col = h.screen.find("Column");
    h.update(json!({ "items": items(&["a", "b", "d"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "d", "footer"]));
    h.update(json!({ "items": items(&["a", "b", "c", "d"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "c", "d", "footer"]));
    h.update(json!({ "items": items(&["a", "b", "c", "d", "e", "f"]) }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["a", "b", "c", "d", "e", "f", "footer"])
    );
}

#[test]
fn foreach_reorder_moving_a_row_to_the_end_stays_before_sibling() {
    let mut h = Harness::new(
        LIST_THEN_FOOTER,
        json!({ "items": items(&["a", "b", "c"]) }),
    );
    let col = h.screen.find("Column");
    // `a` moves to the end of the range: its Move must anchor on the footer.
    h.update(json!({ "items": items(&["b", "c", "a"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "c", "a", "footer"]));
    h.update(json!({ "items": items(&["a", "c", "b"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "c", "b", "footer"]));
    // Reorder plus insert plus remove in one pass.
    h.update(json!({ "items": items(&["x", "b", "a"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["x", "b", "a", "footer"]));
}

#[test]
fn empty_foreach_gaining_its_first_item_lands_between_siblings() {
    let mut h = Harness::new(
        r#"Column { Text("header") ForEach(items: @state.items, key: "id") { Text("@{item.name}") } Text("footer") }"#,
        json!({ "items": [] }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "items": items(&["a"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["header", "a", "footer"]));
    h.update(json!({ "items": [] }));
    h.update(json!({ "items": items(&["a", "b"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["header", "a", "b", "footer"]));
}

#[test]
fn multi_template_foreach_rows_stay_before_sibling() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id") { Text("@{item.name}") Text("-") } Text("footer") }"#,
        json!({ "items": items(&["a"]) }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "items": items(&["b", "a"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "-", "a", "-", "footer"]));
    h.update(json!({ "items": items(&["a", "b"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "-", "b", "-", "footer"]));
}

#[test]
fn two_adjacent_foreachs_keep_their_ranges() {
    let mut h = Harness::new(
        r#"Column {
            ForEach(items: @state.left, key: "id") { Text("@{item.name}") }
            ForEach(items: @state.right, key: "id") { Text("@{item.name}") }
            Text("footer")
        }"#,
        json!({ "left": items(&["l1"]), "right": items(&["r1"]) }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "left": items(&["l1", "l2"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["l1", "l2", "r1", "footer"]));
    h.update(json!({ "right": items(&["r1", "r2"]) }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["l1", "l2", "r1", "r2", "footer"])
    );
    // Second list empties; the first one's appends then anchor past it on
    // the footer.
    h.update(json!({ "right": [] }));
    h.update(json!({ "left": items(&["l2", "l1", "l3"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["l2", "l1", "l3", "footer"]));
    h.update(json!({ "right": items(&["r9"]) }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["l2", "l1", "l3", "r9", "footer"])
    );
}

// ---------------------------------------------------------------------------
// If / When toggling on before a sibling
// ---------------------------------------------------------------------------

#[test]
fn if_toggling_on_lands_before_following_sibling() {
    let mut h = Harness::new(
        r#"Column { Text("top") If(@state.show) { Text("a") Text("a2") } Text("b") }"#,
        json!({ "show": false }),
    );
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["top", "b"]));
    h.update(json!({ "show": true }));
    assert_eq!(h.screen.rows(&col), strs(&["top", "a", "a2", "b"]));
    h.update(json!({ "show": false }));
    h.update(json!({ "show": true }));
    assert_eq!(h.screen.rows(&col), strs(&["top", "a", "a2", "b"]));
}

#[test]
fn when_switching_branches_lands_before_following_sibling() {
    let mut h = Harness::new(
        r#"Column {
            When(value: @state.mode) {
                Case(match: "one") { Text("one") }
                Case(match: "two") { Text("two") Text("two-b") }
            }
            Text("footer")
        }"#,
        json!({ "mode": "none" }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "mode": "one" }));
    assert_eq!(h.screen.rows(&col), strs(&["one", "footer"]));
    h.update(json!({ "mode": "two" }));
    assert_eq!(h.screen.rows(&col), strs(&["two", "two-b", "footer"]));
}

#[test]
fn adjacent_ifs_toggling_in_either_order() {
    let src = r#"Column { If(@state.a) { Text("a") } If(@state.b) { Text("b") } Text("c") }"#;
    let mut h = Harness::new(src, json!({ "a": false, "b": false }));
    let col = h.screen.find("Column");
    h.update(json!({ "b": true }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "c"]));
    h.update(json!({ "a": true }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "c"]));

    // Both on in the same pass.
    let mut h = Harness::new(src, json!({ "a": false, "b": false }));
    let col = h.screen.find("Column");
    h.update(json!({ "a": true, "b": true }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "c"]));
}

// ---------------------------------------------------------------------------
// Nested control flow
// ---------------------------------------------------------------------------

#[test]
fn if_inside_foreach_rows_keep_order_and_stay_before_sibling() {
    let mut h = Harness::new(
        r#"Column {
            ForEach(items: @state.items, key: "id") {
                If(condition: "@{item.on}") { Text("@{item.name}") }
            }
            Text("footer")
        }"#,
        json!({ "items": [
            { "id": "a", "name": "a", "on": true },
            { "id": "b", "name": "b", "on": false },
            { "id": "c", "name": "c", "on": true },
        ] }),
    );
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["a", "c", "footer"]));
    // A reused row's If turning on must land between its neighbours.
    h.update(json!({ "items": [
        { "id": "a", "name": "a", "on": true },
        { "id": "b", "name": "b", "on": true },
        { "id": "c", "name": "c", "on": true },
    ] }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "c", "footer"]));
    // Reorder rows rooted at control flow (moves their rendered content),
    // with a new row whose If is on.
    h.update(json!({ "items": [
        { "id": "c", "name": "c", "on": true },
        { "id": "d", "name": "d", "on": true },
        { "id": "b", "name": "b", "on": false },
        { "id": "a", "name": "a", "on": true },
    ] }));
    assert_eq!(h.screen.rows(&col), strs(&["c", "d", "a", "footer"]));
}

#[test]
fn foreach_inside_if_lands_before_following_sibling() {
    let mut h = Harness::new(
        r#"Column {
            If(@state.show) {
                ForEach(items: @state.items, key: "id") { Text("@{item.name}") }
            }
            Text("footer")
        }"#,
        json!({ "show": false, "items": items(&["a"]) }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "show": true }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "footer"]));
    h.update(json!({ "items": items(&["a", "b"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "footer"]));
    h.update(json!({ "items": items(&["b", "a"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "a", "footer"]));
}

#[test]
fn foreach_inside_element_rows_stays_in_row() {
    // Control flow nested inside a list ROW element: anchors resolve inside
    // the row, never against the outer list's siblings.
    let mut h = Harness::new(
        r#"Column {
            ForEach(items: @state.groups, key: "id") {
                Row { ForEach(items: @item.kids, as: "k", key: "id") { Text("@{k.name}") } Text("end") }
            }
            Text("footer")
        }"#,
        json!({ "groups": [ { "id": "g", "kids": items(&["x"]) } ] }),
    );
    let row = h.screen.find("Row");
    h.update(json!({ "groups": [ { "id": "g", "kids": items(&["x", "y"]) } ] }));
    assert_eq!(h.screen.rows(&row), strs(&["x", "y", "end"]));
}

// ---------------------------------------------------------------------------
// Windowed (lazy) ForEach
// ---------------------------------------------------------------------------

fn numbered(range: std::ops::Range<usize>) -> Value {
    Value::Array(
        range
            .map(|i| json!({ "id": i, "name": format!("r{i}") }))
            .collect(),
    )
}

fn numbered_rows(range: std::ops::Range<usize>, per_row: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for i in range {
        out.push(format!("r{i}"));
        out.extend(per_row.iter().map(|s| s.to_string()));
    }
    out
}

#[test]
fn windowed_foreach_scrolling_keeps_row_order() {
    // A windowed ForEach is the sole child of its element; its siblings live
    // one level up. Multi-template rows exercise multi-node moves.
    let mut h = Harness::new(
        r#"Column {
            Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 4) { Text("@{item.name}") Text("-") } }
            Text("footer")
        }"#,
        json!({ "items": numbered(0..40) }),
    );
    let inner = h
        .screen
        .types
        .iter()
        .find(|(id, t)| *t == "Column" && h.screen.props[*id].contains_key("__virt.window"))
        .map(|(id, _)| id.clone())
        .expect("windowed column");
    assert_eq!(h.screen.rows(&inner), numbered_rows(0..4, &["-"]));
    h.viewport(&inner, 10, 14);
    assert_eq!(h.screen.rows(&inner), numbered_rows(10..14, &["-"]));
    // Scroll up by two: rows enter at the TOP of the window.
    h.viewport(&inner, 8, 12);
    assert_eq!(h.screen.rows(&inner), numbered_rows(8..12, &["-"]));
    h.viewport(&inner, 9, 15);
    assert_eq!(h.screen.rows(&inner), numbered_rows(9..15, &["-"]));
}

#[test]
fn lazy_foreach_gaining_a_sibling_expands_in_order() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 3) { Text("@{item.name}") } }"#,
        json!({ "items": numbered(0..6) }),
    );
    let col = h.screen.find("Column");
    let ir = ast_to_ir_node(
        &parse_component(
            r#"Column { ForEach(items: @state.items, key: "id", lazy: true, initialCount: 3) { Text("@{item.name}") } Text("footer") }"#,
        )
        .unwrap(),
    );
    h.engine.render_ir_node(&ir);
    h.flush();
    let mut expected = numbered_rows(0..6, &[]);
    expected.push("footer".into());
    assert_eq!(h.screen.rows(&col), expected);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

#[test]
fn router_navigation_lands_before_following_sibling() {
    let mut h = Harness::new(
        r#"Column {
            Text("nav")
            Router {
                Route(path: "/a") { Text("page a") }
                Route(path: "/b") { Text("page b") Text("page b2") }
            }
            Text("footer")
        }"#,
        json!({ "location": "/a" }),
    );
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["nav", "page a", "footer"]));
    // Cache miss: fresh route subtree.
    h.update(json!({ "location": "/b" }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "page b", "page b2", "footer"])
    );
    // Cache hit: Attach of the detached `/a` subtree.
    h.update(json!({ "location": "/a" }));
    assert_eq!(h.screen.rows(&col), strs(&["nav", "page a", "footer"]));
    h.update(json!({ "location": "/b" }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "page b", "page b2", "footer"])
    );
}

// ---------------------------------------------------------------------------
// Replacement keeps the slot
// ---------------------------------------------------------------------------

#[test]
fn row_type_change_on_hot_reload_keeps_order() {
    let mut h = Harness::new(LIST_THEN_FOOTER, json!({ "items": items(&["a", "b"]) }));
    let col = h.screen.find("Column");
    let ir = ast_to_ir_node(
        &parse_component(
            r#"Column { ForEach(items: @state.items, key: "id") { Button("@{item.name}") } Text("footer") }"#,
        )
        .unwrap(),
    );
    h.engine.render_ir_node(&ir);
    h.flush();
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "footer"]));
    // The replaced rows are still matched by key afterwards.
    h.engine
        .update_state(None, json!({ "items": items(&["b", "a", "c"]) }));
    h.flush();
    assert_eq!(h.screen.rows(&col), strs(&["b", "a", "c", "footer"]));
}

// ---------------------------------------------------------------------------
// Router routes rooted at control flow
// ---------------------------------------------------------------------------

const ROUTER_CF: &str = r#"Column {
    Text("nav")
    Router {
        Route(path: "/list") {
            ForEach(items: @state.items, key: "id") { Text("@{item.name}") }
            If(@state.show) { Text("shown") }
        }
        Route(path: "/other") { Text("other") }
    }
    Text("footer")
}"#;

#[test]
fn router_route_rooted_at_control_flow_detaches_and_reattaches_its_content() {
    let mut h = Harness::new(
        ROUTER_CF,
        json!({ "location": "/list", "items": items(&["a", "b"]), "show": true }),
    );
    let col = h.screen.find("Column");
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "a", "b", "shown", "footer"])
    );
    h.update(json!({ "location": "/other" }));
    assert_eq!(h.screen.rows(&col), strs(&["nav", "other", "footer"]));
    h.update(json!({ "location": "/list" }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "a", "b", "shown", "footer"])
    );
}

#[test]
fn router_control_flow_route_updated_while_away_catches_up_on_return() {
    let mut h = Harness::new(
        ROUTER_CF,
        json!({ "location": "/list", "items": items(&["a", "b"]), "show": false }),
    );
    let col = h.screen.find("Column");
    h.update(json!({ "location": "/other" }));
    // Off-screen edits must not leak onto the screen (or into "root").
    h.update(json!({ "items": items(&["c", "a"]), "show": true }));
    assert_eq!(h.screen.rows(&col), strs(&["nav", "other", "footer"]));
    h.update(json!({ "location": "/list" }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "c", "a", "shown", "footer"])
    );
    // And it stays live once back.
    h.update(json!({ "items": items(&["c", "a", "d"]) }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["nav", "c", "a", "d", "shown", "footer"])
    );
}

#[test]
fn nested_router_as_route_root_keeps_order_across_navigation() {
    let mut h = Harness::new(
        r#"Column {
            Router {
                Route(path: "/in/*") {
                    Router(value: @state.sub) {
                        Route(path: "x") { Text("x1") Text("x2") }
                        Route(path: "y") { Text("y1") }
                    }
                }
                Route(path: "/out") { Text("out") }
            }
            Text("footer")
        }"#,
        json!({ "location": "/in/a", "sub": "x" }),
    );
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["x1", "x2", "footer"]));
    h.update(json!({ "location": "/out" }));
    assert_eq!(h.screen.rows(&col), strs(&["out", "footer"]));
    h.update(json!({ "sub": "y" }));
    assert_eq!(h.screen.rows(&col), strs(&["out", "footer"]));
    h.update(json!({ "location": "/in/b" }));
    assert_eq!(h.screen.rows(&col), strs(&["y1", "footer"]));
    h.update(json!({ "sub": "x" }));
    assert_eq!(h.screen.rows(&col), strs(&["x1", "x2", "footer"]));
}

#[test]
fn evicted_control_flow_route_is_removed_from_the_renderer() {
    let mut routes = String::from(
        r#"Route(path: "/list") { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }"#,
    );
    for i in 0..12 {
        routes.push_str(&format!(r#" Route(path: "/p{i}") {{ Text("p{i}") }}"#));
    }
    let src = format!(r#"Column {{ Router {{ {routes} }} Text("footer") }}"#);
    let mut h = Harness::new(
        &src,
        json!({ "location": "/list", "items": items(&["a", "b"]) }),
    );
    for i in 0..12 {
        h.update(json!({ "location": format!("/p{i}") }));
    }
    // `/list` fell out of the LRU: its rows are gone from the renderer, not
    // leaked as detached nodes.
    assert!(
        !h.screen
            .types
            .keys()
            .any(|id| ["a", "b"].contains(&h.screen.label(id).as_str())),
        "evicted route rows still alive in the renderer"
    );
    h.update(json!({ "location": "/list" }));
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["a", "b", "footer"]));
}

// ---------------------------------------------------------------------------
// Root-level control flow (content placed straight into "root")
// ---------------------------------------------------------------------------

impl Screen {
    /// Labels of the root container's children, in order.
    fn root_rows(&self) -> Vec<String> {
        self.roots.iter().map(|id| self.label(id)).collect()
    }
}

#[test]
fn root_router_route_if_toggle_lands_before_sibling() {
    let mut h = Harness::new(
        r#"Router { Route(path: "/") { If(@state.banner) { Text("banner") } Text("body") } }"#,
        json!({ "location": "/", "banner": false }),
    );
    assert_eq!(h.screen.root_rows(), strs(&["body"]));
    h.update(json!({ "banner": true }));
    assert_eq!(h.screen.root_rows(), strs(&["banner", "body"]));
    h.update(json!({ "banner": false }));
    h.update(json!({ "banner": true }));
    assert_eq!(h.screen.root_rows(), strs(&["banner", "body"]));
}

#[test]
fn root_if_children_keep_order_before_root_sibling() {
    let mut h = Harness::new(
        r#"If(@state.on) {
            If(@state.banner) { Text("banner") }
            ForEach(items: @state.items, key: "id") { Text("@{item.name}") }
            Text("footer")
        }"#,
        json!({ "on": true, "banner": false, "items": items(&["a", "b"]) }),
    );
    assert_eq!(h.screen.root_rows(), strs(&["a", "b", "footer"]));
    h.update(json!({ "banner": true }));
    assert_eq!(h.screen.root_rows(), strs(&["banner", "a", "b", "footer"]));
    h.update(json!({ "items": items(&["a", "b", "c"]) }));
    assert_eq!(
        h.screen.root_rows(),
        strs(&["banner", "a", "b", "c", "footer"])
    );
    // Reorder at root: Moves must address "root" and anchor on the footer.
    h.update(json!({ "items": items(&["c", "b", "a"]) }));
    assert_eq!(
        h.screen.root_rows(),
        strs(&["banner", "c", "b", "a", "footer"])
    );
    h.update(json!({ "on": false }));
    assert_eq!(h.screen.root_rows(), Vec::<String>::new());
    h.update(json!({ "on": true }));
    assert_eq!(
        h.screen.root_rows(),
        strs(&["banner", "c", "b", "a", "footer"])
    );
}

#[test]
fn root_foreach_rows_reorder_and_toggle() {
    let mut h = Harness::new(
        r#"ForEach(items: @state.items, key: "id") {
            If(condition: "@{item.on}") { Text("@{item.name}") }
            Text("-")
        }"#,
        json!({ "items": [
            { "id": "a", "name": "a", "on": true },
            { "id": "b", "name": "b", "on": false },
            { "id": "c", "name": "c", "on": true },
        ] }),
    );
    assert_eq!(h.screen.root_rows(), strs(&["a", "-", "-", "c", "-"]));
    h.update(json!({ "items": [
        { "id": "c", "name": "c", "on": true },
        { "id": "b", "name": "b", "on": true },
        { "id": "a", "name": "a", "on": false },
    ] }));
    assert_eq!(h.screen.root_rows(), strs(&["c", "-", "b", "-", "-"]));
    h.update(json!({ "items": [
        { "id": "a", "name": "a", "on": true },
        { "id": "d", "name": "d", "on": true },
        { "id": "c", "name": "c", "on": true },
    ] }));
    assert_eq!(h.screen.root_rows(), strs(&["a", "-", "d", "-", "c", "-"]));
}

#[test]
fn root_router_route_with_foreach_and_sibling() {
    let mut h = Harness::new(
        r#"Router {
            Route(path: "/list") {
                ForEach(items: @state.items, key: "id") { Text("@{item.name}") }
                Text("footer")
            }
            Route(path: "/other") { Text("other") }
        }"#,
        json!({ "location": "/list", "items": items(&["a"]) }),
    );
    assert_eq!(h.screen.root_rows(), strs(&["a", "footer"]));
    h.update(json!({ "items": items(&["a", "b"]) }));
    assert_eq!(h.screen.root_rows(), strs(&["a", "b", "footer"]));
    h.update(json!({ "items": items(&["b", "a"]) }));
    assert_eq!(h.screen.root_rows(), strs(&["b", "a", "footer"]));
    h.update(json!({ "location": "/other" }));
    assert_eq!(h.screen.root_rows(), strs(&["other"]));
    h.update(json!({ "items": items(&["c", "b", "a"]) }));
    h.update(json!({ "location": "/list" }));
    assert_eq!(h.screen.root_rows(), strs(&["c", "b", "a", "footer"]));
}

// ---------------------------------------------------------------------------
// Mixed passes
// ---------------------------------------------------------------------------

#[test]
fn if_rooted_rows_reordered_and_toggled_in_one_pass() {
    let mut h = Harness::new(
        r#"Column {
            ForEach(items: @state.items, key: "id") {
                If(condition: "@{item.on}") { Text("@{item.name}") }
            }
            Text("footer")
        }"#,
        json!({ "items": [
            { "id": "a", "name": "a", "on": true },
            { "id": "b", "name": "b", "on": false },
            { "id": "c", "name": "c", "on": true },
            { "id": "d", "name": "d", "on": true },
        ] }),
    );
    let col = h.screen.find("Column");
    // Reverse while d turns off and b turns on.
    h.update(json!({ "items": [
        { "id": "d", "name": "d", "on": false },
        { "id": "c", "name": "c", "on": true },
        { "id": "b", "name": "b", "on": true },
        { "id": "a", "name": "a", "on": true },
    ] }));
    assert_eq!(h.screen.rows(&col), strs(&["c", "b", "a", "footer"]));
    // Move an off row to the front while it turns on; the last row moves
    // to the middle while turning off.
    h.update(json!({ "items": [
        { "id": "d", "name": "d", "on": true },
        { "id": "a", "name": "a", "on": false },
        { "id": "c", "name": "c", "on": true },
        { "id": "b", "name": "b", "on": true },
    ] }));
    assert_eq!(h.screen.rows(&col), strs(&["d", "c", "b", "footer"]));
    h.update(json!({ "items": [
        { "id": "b", "name": "b", "on": true },
        { "id": "a", "name": "a", "on": true },
        { "id": "d", "name": "d", "on": true },
        { "id": "c", "name": "c", "on": false },
    ] }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "a", "d", "footer"]));
}

#[test]
fn foreach_rows_that_are_foreachs_reorder_as_multi_root_moves() {
    let group = |id: &str, kids: &[&str]| json!({ "id": id, "kids": items(kids) });
    let mut h = Harness::new(
        r#"Column {
            ForEach(items: @state.groups, key: "id") {
                ForEach(items: @item.kids, as: "k", key: "id") { Text("@{k.name}") }
            }
            Text("footer")
        }"#,
        json!({ "groups": [
            group("g1", &["x1", "x2"]),
            group("g2", &["y1"]),
            group("g3", &["z1", "z2"]),
        ] }),
    );
    let col = h.screen.find("Column");
    assert_eq!(
        h.screen.rows(&col),
        strs(&["x1", "x2", "y1", "z1", "z2", "footer"])
    );
    h.update(json!({ "groups": [
        group("g3", &["z1", "z2"]),
        group("g1", &["x1", "x2"]),
        group("g2", &["y1"]),
    ] }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["z1", "z2", "x1", "x2", "y1", "footer"])
    );
    // Reverse while the groups' own rows change, and an empty group sits
    // between them.
    h.update(json!({ "groups": [
        group("g2", &["y2", "y1"]),
        group("g4", &[]),
        group("g1", &["x2"]),
        group("g3", &["z1", "z2", "z3"]),
    ] }));
    assert_eq!(
        h.screen.rows(&col),
        strs(&["y2", "y1", "x2", "z1", "z2", "z3", "footer"])
    );
}

#[test]
fn row_type_change_in_a_pass_that_also_creates_rows() {
    let mut h = Harness::new(LIST_THEN_FOOTER, json!({ "items": items(&["a", "b"]) }));
    let col = h.screen.find("Column");
    let source = r#"Column { ForEach(items: @state.items, key: "id") { Button("@{item.name}") } Text("footer") }"#;
    // New state AND new templates in one render: `a`/`b` are replaced in
    // their slots while `c` and `z` are created around them.
    let state = json!({ "items": items(&["z", "a", "b", "c"]) });
    h.engine
        .set_module(ModuleInstance::new(Module::new("Test"), state.clone()));
    h.engine
        .render_ir_node(&ast_to_ir_node(&parse_component(source).unwrap()));
    h.flush();
    h.source = source.to_string();
    h.state = state;
    assert_eq!(h.screen.rows(&col), strs(&["z", "a", "b", "c", "footer"]));
    h.assert_matches_fresh_render();
    h.update(json!({ "items": items(&["c", "a", "y"]) }));
    assert_eq!(h.screen.rows(&col), strs(&["c", "a", "y", "footer"]));
}

// ---------------------------------------------------------------------------
// Deferred control flow under torn-down routes
// ---------------------------------------------------------------------------

#[test]
fn deferred_route_evicted_before_return_leaves_nothing_pending() {
    let mut routes = String::from(
        r#"Route(path: "/list") {
            ForEach(items: @state.items, key: "id") { Text("@{item.name}") }
            If(@state.show) { Text("shown") }
        }"#,
    );
    for i in 0..12 {
        routes.push_str(&format!(r#" Route(path: "/p{i}") {{ Text("p{i}") }}"#));
    }
    let src = format!(r#"Column {{ Router {{ {routes} }} Text("footer") }}"#);
    let mut h = Harness::new(
        &src,
        json!({ "location": "/list", "items": items(&["a", "b"]), "show": false }),
    );
    h.update(json!({ "location": "/p0" }));
    h.update(json!({ "items": items(&["c", "a"]), "show": true }));
    assert!(h.engine.deferred_detached_len() > 0, "edits were deferred");
    for i in 1..12 {
        h.update(json!({ "location": format!("/p{i}") }));
    }
    assert_eq!(
        h.engine.deferred_detached_len(),
        0,
        "evicted route left deferred ids behind"
    );
    h.update(json!({ "location": "/list" }));
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["c", "a", "shown", "footer"]));
}

const ROUTER_LIST: &str = r#"Router {
    Route(path: "/list") { ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }
    Route(path: "/other") { Text("other") }
}"#;

#[test]
fn deferred_ids_dropped_when_the_router_is_removed() {
    let src = format!(r#"Column {{ If(@state.on) {{ {ROUTER_LIST} }} Text("footer") }}"#);
    let mut h = Harness::new(
        &src,
        json!({ "on": true, "location": "/list", "items": items(&["a"]) }),
    );
    h.update(json!({ "location": "/other" }));
    h.update(json!({ "items": items(&["b", "a"]) }));
    assert!(h.engine.deferred_detached_len() > 0, "edits were deferred");
    h.update(json!({ "on": false }));
    assert_eq!(h.engine.deferred_detached_len(), 0);
    h.update(json!({ "on": true, "location": "/list" }));
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["b", "a", "footer"]));
}

#[test]
fn deferred_ids_dropped_when_a_parent_when_switches_away() {
    let src = format!(
        r#"Column {{
            When(value: @state.mode) {{
                Case(match: "r") {{ {ROUTER_LIST} }}
                Case(match: "x") {{ Text("x") }}
            }}
            Text("footer")
        }}"#
    );
    let mut h = Harness::new(
        &src,
        json!({ "mode": "r", "location": "/list", "items": items(&["a"]) }),
    );
    h.update(json!({ "location": "/other" }));
    h.update(json!({ "items": items(&["b", "a"]) }));
    assert!(h.engine.deferred_detached_len() > 0, "edits were deferred");
    h.update(json!({ "mode": "x" }));
    assert_eq!(h.engine.deferred_detached_len(), 0);
    let col = h.screen.find("Column");
    assert_eq!(h.screen.rows(&col), strs(&["x", "footer"]));
    h.update(json!({ "mode": "r", "location": "/list" }));
    assert_eq!(h.screen.rows(&col), strs(&["b", "a", "footer"]));
}
