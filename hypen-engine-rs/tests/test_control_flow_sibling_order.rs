//! Render-order regression tests for control-flow nodes that share a render
//! parent with later siblings.
//!
//! ForEach / If / When are transparent: their children are inserted straight
//! into the nearest element ancestor, interleaved with the siblings that
//! follow them. Any child they create AFTER the initial render must therefore
//! be inserted *before* the first rendered node of the next sibling — an
//! append (`before_id: None`) puts it below content that should come later.
//!
//! The original report (chat tutorial):
//!
//! ```hypen
//! Column {
//!     ForEach(items: @state.messages, key: "id") { Text("@{item.content}") }
//!     If(condition: @state.isLoading) { Text("Thinking...") }
//! }
//! ```
//!
//! appending a message while `isLoading` was true rendered "Thinking..."
//! ABOVE the new message.
//!
//! These tests apply the emitted patches to a minimal mock renderer and
//! assert the resulting visual order.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::{Engine, TemplateExpander};
use hypen_parser::parse_component;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockDom {
    types: HashMap<String, String>,
    text: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    parent: HashMap<String, String>,
}

impl MockDom {
    fn unlink(&mut self, id: &str) {
        if let Some(p) = self.parent.remove(id) {
            if let Some(kids) = self.children.get_mut(&p) {
                kids.retain(|k| k != id);
            }
        }
    }

    fn link(&mut self, parent: &str, id: &str, before: Option<&str>) {
        self.unlink(id);
        let kids = self.children.entry(parent.to_string()).or_default();
        let pos = match before {
            Some(b) => kids
                .iter()
                .position(|k| k == b)
                .unwrap_or_else(|| panic!("before_id {b} is not a child of {parent}")),
            None => kids.len(),
        };
        kids.insert(pos, id.to_string());
        self.parent.insert(id.to_string(), parent.to_string());
    }

    fn apply(&mut self, patches: &[Patch]) {
        for p in patches {
            match p {
                Patch::Create {
                    id,
                    element_type,
                    props,
                    ..
                } => {
                    self.types.insert(id.to_string(), element_type.clone());
                    if let Some(serde_json::Value::String(s)) = props.get("0") {
                        self.text.insert(id.to_string(), s.clone());
                    }
                }
                Patch::SetProp {
                    id,
                    name,
                    value: serde_json::Value::String(s),
                } if name == "0" => {
                    self.text.insert(id.to_string(), s.clone());
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
                } => self.link(parent_id, id, before_id.as_deref()),
                Patch::Remove { id, .. } | Patch::Detach { id } => self.unlink(id),
                _ => {}
            }
        }
    }

    /// Text content of every `Text` node, in document order.
    fn texts(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.walk("root", &mut out);
        out
    }

    fn walk(&self, id: &str, out: &mut Vec<String>) {
        if self.types.get(id).map(String::as_str) == Some("Text") {
            if let Some(t) = self.text.get(id) {
                out.push(t.clone());
            }
        }
        if let Some(kids) = self.children.get(id) {
            for k in kids {
                self.walk(k, out);
            }
        }
    }
}

struct Harness {
    engine: Engine,
    patches: Arc<Mutex<Vec<Patch>>>,
    expander: TemplateExpander,
    dom: MockDom,
}

impl Harness {
    fn new(source: &str, state: serde_json::Value) -> Self {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new("App"), state));
        let patches: Arc<Mutex<Vec<Patch>>> = Arc::default();
        let sink = patches.clone();
        engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
        let ir = ast_to_ir_node(&parse_component(source).unwrap());
        engine.render_ir_node(&ir);
        let mut h = Harness {
            engine,
            patches,
            expander: TemplateExpander::new(),
            dom: MockDom::default(),
        };
        h.flush();
        h
    }

    fn flush(&mut self) {
        let batch = std::mem::take(&mut *self.patches.lock().unwrap());
        let lowered = self.expander.expand(batch);
        self.dom.apply(&lowered);
    }

    fn update(&mut self, patch: serde_json::Value) -> Vec<String> {
        self.engine.update_state(None, patch);
        self.flush();
        self.dom.texts()
    }

    fn texts(&self) -> Vec<String> {
        self.dom.texts()
    }
}

fn msgs(items: &[&str]) -> serde_json::Value {
    json!(items
        .iter()
        .map(|s| json!({"id": s, "content": s}))
        .collect::<Vec<_>>())
}

const CHAT: &str = r#"
Column {
    ForEach(items: @state.messages, key: "id") {
        Text("@{item.content}")
    }
    If(condition: @state.isLoading) {
        Text("Thinking...")
    }
}
"#;

#[test]
fn foreach_append_lands_before_visible_if_sibling() {
    let mut h = Harness::new(CHAT, json!({"messages": msgs(&["a"]), "isLoading": false}));
    assert_eq!(h.texts(), ["a"]);

    // User sends a message: it is appended and the indicator turns on.
    let out = h.update(json!({"messages": msgs(&["a", "b"]), "isLoading": true}));
    assert_eq!(out, ["a", "b", "Thinking..."]);

    // A message arrives while the indicator is still visible.
    let out = h.update(json!({"messages": msgs(&["a", "b", "c"])}));
    assert_eq!(out, ["a", "b", "c", "Thinking..."]);

    let out = h.update(json!({"isLoading": false}));
    assert_eq!(out, ["a", "b", "c"]);
}

#[test]
fn foreach_append_from_empty_lands_before_visible_if_sibling() {
    let mut h = Harness::new(CHAT, json!({"messages": [], "isLoading": true}));
    assert_eq!(h.texts(), ["Thinking..."]);
    let out = h.update(json!({"messages": msgs(&["a"])}));
    assert_eq!(out, ["a", "Thinking..."]);
    let out = h.update(json!({"messages": msgs(&["a", "b"])}));
    assert_eq!(out, ["a", "b", "Thinking..."]);
}

#[test]
fn foreach_reorder_stays_before_following_element() {
    let src = r#"
    Column {
        ForEach(items: @state.messages, key: "id") { Text("@{item.content}") }
        Text("footer")
    }
    "#;
    let mut h = Harness::new(src, json!({"messages": msgs(&["a", "b", "c"])}));
    assert_eq!(h.texts(), ["a", "b", "c", "footer"]);
    // Reorder that moves the old head to the tail: its Move anchor must be
    // the footer, not an append.
    let out = h.update(json!({"messages": msgs(&["b", "c", "a"])}));
    assert_eq!(out, ["b", "c", "a", "footer"]);
    let out = h.update(json!({"messages": msgs(&["b", "c", "a", "d"])}));
    assert_eq!(out, ["b", "c", "a", "d", "footer"]);
}

#[test]
fn foreach_append_lands_before_visible_when_sibling() {
    let src = r#"
    Column {
        ForEach(items: @state.messages, key: "id") { Text("@{item.content}") }
        When(value: @state.status) {
            Case(match: "loading") { Text("Loading...") }
            Else { Text("Idle") }
        }
    }
    "#;
    let mut h = Harness::new(src, json!({"messages": msgs(&["a"]), "status": "loading"}));
    assert_eq!(h.texts(), ["a", "Loading..."]);
    let out = h.update(json!({"messages": msgs(&["a", "b"])}));
    assert_eq!(out, ["a", "b", "Loading..."]);
    let out = h.update(json!({"status": "done"}));
    assert_eq!(out, ["a", "b", "Idle"]);
    let out = h.update(json!({"messages": msgs(&["a", "b", "c"])}));
    assert_eq!(out, ["a", "b", "c", "Idle"]);
}

#[test]
fn if_branch_flip_lands_before_following_element() {
    let src = r#"
    Column {
        Text("header")
        If(condition: @state.show) { Text("banner") }
        Text("footer")
    }
    "#;
    let mut h = Harness::new(src, json!({"show": false}));
    assert_eq!(h.texts(), ["header", "footer"]);
    let out = h.update(json!({"show": true}));
    assert_eq!(out, ["header", "banner", "footer"]);
    let out = h.update(json!({"show": false}));
    assert_eq!(out, ["header", "footer"]);
    let out = h.update(json!({"show": true}));
    assert_eq!(out, ["header", "banner", "footer"]);
}

#[test]
fn foreach_append_skips_empty_if_and_lands_before_footer() {
    let src = r#"
    Column {
        ForEach(items: @state.messages, key: "id") { Text("@{item.content}") }
        If(condition: @state.isLoading) { Text("Thinking...") }
        Text("footer")
    }
    "#;
    let mut h = Harness::new(src, json!({"messages": msgs(&["a"]), "isLoading": false}));
    assert_eq!(h.texts(), ["a", "footer"]);
    let out = h.update(json!({"messages": msgs(&["a", "b"])}));
    assert_eq!(out, ["a", "b", "footer"]);
    let out = h.update(json!({"isLoading": true}));
    assert_eq!(out, ["a", "b", "Thinking...", "footer"]);
    let out = h.update(json!({"messages": msgs(&["a", "b", "c"])}));
    assert_eq!(out, ["a", "b", "c", "Thinking...", "footer"]);
}

#[test]
fn nested_control_flow_keeps_order() {
    // ForEach nested inside an If, followed by a sibling of the If; and an
    // If nested inside an If following a ForEach.
    let src = r#"
    Column {
        If(condition: @state.open) {
            ForEach(items: @state.messages, key: "id") { Text("@{item.content}") }
            If(condition: @state.isLoading) { Text("Thinking...") }
        }
        Text("footer")
    }
    "#;
    let mut h = Harness::new(
        src,
        json!({"open": true, "messages": msgs(&["a"]), "isLoading": true}),
    );
    assert_eq!(h.texts(), ["a", "Thinking...", "footer"]);
    let out = h.update(json!({"messages": msgs(&["a", "b"])}));
    assert_eq!(out, ["a", "b", "Thinking...", "footer"]);
    let out = h.update(json!({"isLoading": false}));
    assert_eq!(out, ["a", "b", "footer"]);
    let out = h.update(json!({"messages": msgs(&["a", "b", "c"])}));
    assert_eq!(out, ["a", "b", "c", "footer"]);
    let out = h.update(json!({"isLoading": true}));
    assert_eq!(out, ["a", "b", "c", "Thinking...", "footer"]);
    let out = h.update(json!({"open": false}));
    assert_eq!(out, ["footer"]);
    let out = h.update(json!({"open": true}));
    assert_eq!(out, ["a", "b", "c", "Thinking...", "footer"]);
}

#[test]
fn nested_foreach_over_custom_named_outer_item() {
    // The docs' nested example: inner source reads the outer `as:` variable.
    let src = r#"
    Column {
        ForEach(items: @state.categories, as: "category", key: "id") {
            Column {
                Text("@{category.name}")
                ForEach(items: @category.products, as: "product", key: "sku") {
                    Text("@{product.name}")
                }
            }
        }
    }
    "#;
    let cat = |id: &str, products: &[&str]| json!({"id": id, "name": id, "products": products.iter().map(|p| json!({"sku": p, "name": p})).collect::<Vec<_>>()});
    let mut h = Harness::new(
        src,
        json!({"categories": [cat("fruit", &["apple"]), cat("veg", &["kale"])]}),
    );
    assert_eq!(h.texts(), ["fruit", "apple", "veg", "kale"]);
    let out =
        h.update(json!({"categories": [cat("fruit", &["apple", "pear"]), cat("veg", &["kale"])]}));
    assert_eq!(out, ["fruit", "apple", "pear", "veg", "kale"]);
    let out = h.update(json!({"categories": [cat("fruit", &["pear"]), cat("veg", &[])]}));
    assert_eq!(out, ["fruit", "pear", "veg"]);
}

#[test]
fn nested_foreach_rows_stay_in_their_group() {
    let src = r#"
    Column {
        ForEach(items: @state.groups, key: "id") {
            ForEach(items: @item.items, key: "id", as: "msg") { Text("@{msg.content}") }
            Text("@{item.id}-end")
        }
    }
    "#;
    let g = |id: &str, items: &[&str]| json!({"id": id, "items": msgs(items)});
    let mut h = Harness::new(src, json!({"groups": [g("g1", &["a"]), g("g2", &["x"])]}));
    assert_eq!(h.texts(), ["a", "g1-end", "x", "g2-end"]);
    let out = h.update(json!({"groups": [g("g1", &["a", "b"]), g("g2", &["x"])]}));
    assert_eq!(out, ["a", "b", "g1-end", "x", "g2-end"]);
}

#[test]
fn two_foreach_siblings_keep_order() {
    let src = r#"
    Column {
        ForEach(items: @state.first, key: "id") { Text("@{item.content}") }
        ForEach(items: @state.second, key: "id") { Text("@{item.content}") }
    }
    "#;
    let mut h = Harness::new(src, json!({"first": msgs(&["a"]), "second": msgs(&["x"])}));
    assert_eq!(h.texts(), ["a", "x"]);
    let out = h.update(json!({"first": msgs(&["a", "b"])}));
    assert_eq!(out, ["a", "b", "x"]);
    let out = h.update(json!({"second": msgs(&["x", "y"]), "first": msgs(&["b", "a"])}));
    assert_eq!(out, ["b", "a", "x", "y"]);
}

#[test]
fn if_per_row_flips_in_place_and_removes_cleanly() {
    let src = r#"
    Column {
        ForEach(items: @state.todos, key: "id") {
            If(condition: @item.done) { Text("@{item.content}") }
        }
        Text("footer")
    }
    "#;
    let todo = |id: &str, done: bool| json!({"id": id, "content": id, "done": done});
    let mut h = Harness::new(
        src,
        json!({"todos": [todo("a", true), todo("b", false), todo("c", true)]}),
    );
    assert_eq!(h.texts(), ["a", "c", "footer"]);
    let out = h.update(json!({"todos": [todo("a", true), todo("b", true), todo("c", true)]}));
    assert_eq!(out, ["a", "b", "c", "footer"]);
    // Dropping a control-flow row must remove what it rendered.
    let out = h.update(json!({"todos": [todo("a", true), todo("c", true)]}));
    assert_eq!(out, ["a", "c", "footer"]);
    let out = h.update(json!({"todos": [todo("a", true), todo("c", true), todo("d", true)]}));
    assert_eq!(out, ["a", "c", "d", "footer"]);
}

#[test]
fn when_branch_with_different_element_type_replaces_in_place() {
    let src = r#"
    Column {
        Text("header")
        When(value: @state.status) {
            Case(match: "loading") { Spinner() }
            Else { Text("ready") }
        }
        Text("footer")
    }
    "#;
    let mut h = Harness::new(src, json!({"status": "idle"}));
    assert_eq!(h.texts(), ["header", "ready", "footer"]);
    let out = h.update(json!({"status": "loading"}));
    assert_eq!(out, ["header", "footer"]);
    assert!(h.dom.types.values().any(|t| t == "Spinner"));
    let column = h.dom.children["root"][0].clone();
    let kinds: Vec<&str> = h.dom.children[&column]
        .iter()
        .map(|id| h.dom.types[id].as_str())
        .collect();
    assert_eq!(
        kinds,
        ["Text", "Spinner", "Text"],
        "Spinner replaces the branch in place"
    );
    let out = h.update(json!({"status": "idle"}));
    assert_eq!(out, ["header", "ready", "footer"]);
}
