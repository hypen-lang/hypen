//! `ForEach(..., as: "todo")` — the iteration alias, end to end.
//!
//! Every test here drives the real `Engine` (parse → IR → component expansion
//! → reconcile → patches) and applies the emitted patches to a tiny in-memory
//! renderer, so assertions are made against what a platform renderer would
//! actually show — including after state updates, keyed reorders and sparse
//! per-item edits.
//!
//! The alias is a real scope name: `@{todo.x}` (template), `@todo.x` (bare
//! reference) and `@todo` (whole row) resolve against the row in text,
//! arguments, applicators, action payloads, expressions, conditionals,
//! custom-component rows and nested loops. `@{item.x}` keeps resolving to the
//! row of an aliased loop it sits directly in (see
//! `item_still_resolves_under_an_aliased_loop`).

use hypen_engine::{
    ir::{ast_to_ir_node, Component, IRNode},
    lifecycle::{Module, ModuleInstance},
    reconcile::Patch,
    Engine, TemplateExpander,
};
use serde_json::{json, Map, Value as Json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Minimal renderer: applies the plain (template-lowered) patch stream.
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Node {
    ty: String,
    props: Map<String, Json>,
    children: Vec<String>,
}

#[derive(Debug, Default)]
struct Dom {
    nodes: HashMap<String, Node>,
    root: Vec<String>,
}

impl Dom {
    fn children_mut(&mut self, parent: &str) -> &mut Vec<String> {
        if parent == "root" {
            &mut self.root
        } else {
            &mut self
                .nodes
                .get_mut(parent)
                .unwrap_or_else(|| panic!("unknown parent {parent}"))
                .children
        }
    }

    fn unlink(&mut self, id: &str) {
        self.root.retain(|c| c != id);
        for n in self.nodes.values_mut() {
            n.children.retain(|c| c != id);
        }
    }

    fn place(&mut self, parent: &str, id: &str, before: Option<&str>) {
        self.unlink(id);
        let list = self.children_mut(parent);
        let at = before
            .and_then(|b| list.iter().position(|c| c == b))
            .unwrap_or(list.len());
        list.insert(at, id.to_string());
    }

    fn apply(&mut self, patch: &Patch) {
        match patch {
            Patch::Create {
                id,
                element_type,
                props,
                ..
            } => {
                let mut map = Map::new();
                for (k, v) in props.iter() {
                    map.insert(k.clone(), v.clone());
                }
                self.nodes.insert(
                    id.to_string(),
                    Node {
                        ty: element_type.clone(),
                        props: map,
                        children: vec![],
                    },
                );
            }
            Patch::SetProp { id, name, value } => {
                if let Some(n) = self.nodes.get_mut(&**id) {
                    n.props.insert(name.clone(), value.clone());
                }
            }
            Patch::RemoveProp { id, name } => {
                if let Some(n) = self.nodes.get_mut(&**id) {
                    n.props.remove(name);
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
            } => self.place(parent_id, id, before_id.as_deref()),
            Patch::Remove { id, .. } => {
                self.unlink(id);
                self.nodes.remove(&**id);
            }
            Patch::Detach { id } => self.unlink(id),
            _ => {}
        }
    }

    fn walk<'a>(&'a self, ids: &'a [String], out: &mut Vec<&'a Node>) {
        for id in ids {
            if let Some(n) = self.nodes.get(id) {
                out.push(n);
                self.walk(&n.children, out);
            }
        }
    }

    /// Every rendered node, depth-first in document order.
    fn all(&self) -> Vec<&Node> {
        let mut out = vec![];
        self.walk(&self.root, &mut out);
        out
    }
}

fn display(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

struct Harness {
    engine: Engine,
    sink: Arc<Mutex<Vec<Patch>>>,
    expander: TemplateExpander,
    dom: Dom,
    /// Patches of the most recent batch (lowered).
    last: Vec<Patch>,
}

impl Harness {
    fn new(source: &str, state: Json) -> Self {
        Self::with_components(source, state, &[])
    }

    fn with_components(source: &str, state: Json, components: &[(&str, &str)]) -> Self {
        let mut engine = Engine::new();
        for (name, body) in components {
            let spec = hypen_parser::parse_component(body).expect("component parses");
            let IRNode::Element(el) = ast_to_ir_node(&spec) else {
                panic!("component root must be an element")
            };
            engine.register_component(Component::new(*name, move |_| el.clone()));
        }
        engine.set_module(ModuleInstance::new(Module::new("Test"), state));
        let sink: Arc<Mutex<Vec<Patch>>> = Arc::default();
        let s = Arc::clone(&sink);
        engine.set_render_callback(move |p| s.lock().unwrap().extend(p.iter().cloned()));
        let mut h = Harness {
            engine,
            sink,
            expander: TemplateExpander::new(),
            dom: Dom::default(),
            last: vec![],
        };
        let spec = hypen_parser::parse_component(source).expect("source parses");
        h.engine.render_ir_node(&ast_to_ir_node(&spec));
        h.drain();
        h
    }

    fn drain(&mut self) {
        let raw = std::mem::take(&mut *self.sink.lock().unwrap());
        self.last = self.expander.expand(raw);
        for p in &self.last {
            self.dom.apply(p);
        }
    }

    fn update(&mut self, patch: Json) {
        self.engine.update_state(None, patch);
        self.drain();
    }

    fn update_sparse(&mut self, path: &str, value: Json) {
        let mut values = Map::new();
        values.insert(path.to_string(), value);
        self.engine
            .update_state_sparse(None, &[path.to_string()], &Json::Object(values));
        self.drain();
    }

    /// Positional content (`"0"`) of every rendered Text, in document order.
    fn texts(&self) -> Vec<String> {
        self.dom
            .all()
            .into_iter()
            .filter(|n| n.ty == "Text")
            .map(|n| n.props.get("0").map(display).unwrap_or_default())
            .collect()
    }

    /// `prop` of every rendered `ty` node, in document order.
    fn prop_of(&self, ty: &str, prop: &str) -> Vec<Json> {
        self.dom
            .all()
            .into_iter()
            .filter(|n| n.ty == ty)
            .map(|n| n.props.get(prop).cloned().unwrap_or(Json::Null))
            .collect()
    }

    fn structural_patches(&self) -> usize {
        self.last
            .iter()
            .filter(|p| matches!(p, Patch::Create { .. } | Patch::Remove { .. }))
            .count()
    }
}

fn todos() -> Json {
    json!({"todos": [
        {"id": 1, "title": "Write", "done": true,  "count": 1, "tags": ["a", "b"]},
        {"id": 2, "title": "Test",  "done": false, "count": 4, "tags": ["c"]}
    ]})
}

// ---------------------------------------------------------------------------
// Text, references, expressions
// ---------------------------------------------------------------------------

#[test]
fn alias_template_text() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.title}")
            Text("n@{todo.id}: @{todo.title}")
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "n1: Write", "Test", "n2: Test"]);
}

#[test]
fn alias_bare_reference_argument() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text(@todo.title)
            Text(text: @todo.count)
        } }"#,
        todos(),
    );
    assert_eq!(
        h.prop_of("Text", "0"),
        [json!("Write"), Json::Null, json!("Test"), Json::Null]
    );
    // Bare references keep the row value's JSON type.
    assert_eq!(
        h.prop_of("Text", "text"),
        [Json::Null, json!(1), Json::Null, json!(4)]
    );
}

#[test]
fn item_expression_under_an_aliased_loop() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{item.done ? 'y' : 'n'} @{todo.title}")
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["y Write", "n Test"]);
}

#[test]
fn alias_matches_whole_identifiers_only() {
    // `todo.` inside `state.todo.` or `mytodo.` is not the row.
    let mut state = todos();
    state["todo"] = json!({"title": "S"});
    state["mytodo"] = json!({"title": "M"});
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.done ? state.todo.title : state.mytodo.title}")
        } }"#,
        state,
    );
    assert_eq!(h.texts(), ["S", "M"]);
}

#[test]
fn legacy_positional_iterable_honors_as_and_key() {
    // `Column(@state.todos) { ... }` is lowered to a ForEach too; it takes
    // the same `as:` / `key:` arguments.
    let mut h = Harness::new(
        r#"Column { Column(@state.todos, as: "todo", key: "id") { Text("@{todo.title}") Text(@todo.count) } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "1", "Test", "4"]);
    h.update(json!({"todos": [
        {"id": 2, "title": "Test",  "done": false, "count": 4, "tags": ["c"]},
        {"id": 1, "title": "Write", "done": true,  "count": 1, "tags": ["a", "b"]}
    ]}));
    assert_eq!(h.texts(), ["Test", "4", "Write", "1"]);
    assert_eq!(h.structural_patches(), 0, "keyed by `key:`: {:?}", h.last);
}

#[test]
fn alias_refs_register_no_phantom_data_source() {
    // `@todo.x` lowers to a data-source-shaped binding; once substituted it
    // must not leave a dependency on a provider called "todo" behind.
    use hypen_engine::reactive::DependencyGraph;
    use hypen_engine::reconcile::{reconcile_ir, InstanceTree};
    let spec = hypen_parser::parse_component(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text(@todo.title).meta(@todo)
            ForEach(items: @todo.tags, as: "tag") { Text(@tag) }
            If(condition: @todo.done) { Text("d") }
        } }"#,
    )
    .unwrap();
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    reconcile_ir(&mut tree, &ast_to_ir_node(&spec), None, &todos(), &mut deps);
    assert!(
        deps.unregistered_provider_refs().is_empty(),
        "alias leaked as a data source: {:?}",
        deps.unregistered_provider_refs()
    );
}

#[test]
fn alias_bare_whole_row_reference() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("x").meta(@todo)
        } }"#,
        todos(),
    );
    let metas = h.prop_of("Text", "meta.0");
    assert_eq!(metas[0]["title"], json!("Write"));
    assert_eq!(metas[1]["id"], json!(2));
}

#[test]
fn alias_expressions() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.done ? 'done' : 'open'}")
            Text("@{todo.count + 1}")
            Text("@{todo.title} has @{todo.count * 2}")
        } }"#,
        todos(),
    );
    assert_eq!(
        h.texts(),
        ["done", "2", "Write has 2", "open", "5", "Test has 8"]
    );
}

#[test]
fn alias_expression_mixing_state() {
    let mut state = todos();
    state["selected"] = json!(2);
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.id == state.selected ? 'sel' : '-'}")
        } }"#,
        state,
    );
    assert_eq!(h.texts(), ["-", "sel"]);
}

// ---------------------------------------------------------------------------
// Applicators and action payloads
// ---------------------------------------------------------------------------

#[test]
fn alias_in_applicators() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("x")
                .color(@todo.title)
                .backgroundColor("@{todo.title}")
                .opacity("@{todo.done ? 0.5 : 1}")
        } }"#,
        todos(),
    );
    assert_eq!(
        h.prop_of("Text", "color.0"),
        [json!("Write"), json!("Test")]
    );
    assert_eq!(
        h.prop_of("Text", "backgroundColor.0"),
        [json!("Write"), json!("Test")]
    );
    // Same as the `item` spelling produces (see below).
    let item = Harness::new(
        r#"Column { ForEach(items: @state.todos, key: "id") {
            Text("x").opacity("@{item.done ? 0.5 : 1}")
        } }"#,
        todos(),
    );
    assert_eq!(
        h.prop_of("Text", "opacity.0"),
        item.prop_of("Text", "opacity.0")
    );
}

#[test]
fn alias_in_action_payload() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Button { Text("toggle") }
                .onClick(@actions.toggle, id: "@{todo.id}", title: @todo.title, row: @todo)
        } }"#,
        todos(),
    );
    assert_eq!(
        h.prop_of("Button", "onClick.0"),
        [json!("@toggle"), json!("@toggle")]
    );
    assert_eq!(h.prop_of("Button", "onClick.id"), [json!(1), json!(2)]);
    assert_eq!(
        h.prop_of("Button", "onClick.title"),
        [json!("Write"), json!("Test")]
    );
    let rows = h.prop_of("Button", "onClick.row");
    assert_eq!(rows[0]["id"], json!(1));
    assert_eq!(rows[1]["title"], json!("Test"));
}

#[test]
fn alias_payload_matches_item_payload() {
    let src = |name: &str, alias: &str| {
        format!(
            r#"Column {{ ForEach(items: @state.todos, {alias} key: "id") {{
                Button {{ Text("t") }}.onClick(@actions.toggle, id: "@{{{name}.id}}", row: @{name})
            }} }}"#
        )
    };
    let aliased = Harness::new(&src("todo", r#"as: "todo","#), todos());
    let plain = Harness::new(&src("item", ""), todos());
    for prop in ["onClick.0", "onClick.id", "onClick.row"] {
        assert_eq!(
            aliased.prop_of("Button", prop),
            plain.prop_of("Button", prop),
            "{prop}"
        );
    }
}

// ---------------------------------------------------------------------------
// List / Grid
// ---------------------------------------------------------------------------

#[test]
fn list_with_alias() {
    let h = Harness::new(
        r#"List(@state.todos, as: "todo", key: "id") { Text("@{todo.title}") Text(@todo.title) }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "Write", "Test", "Test"]);
}

#[test]
fn grid_with_alias() {
    let h = Harness::new(
        r#"Grid(@state.todos, as: "todo", key: "id") { Text("@{todo.title}") }.gridColumns(2)"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "Test"]);
}

// ---------------------------------------------------------------------------
// Custom components as the row
// ---------------------------------------------------------------------------

#[test]
fn alias_in_custom_component_slot_children() {
    let h = Harness::with_components(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Card { Text("@{todo.title}") Text(@todo.title) }
        } }"#,
        todos(),
        &[("Card", r#"Column { Text("card") Children() }"#)],
    );
    assert_eq!(
        h.texts(),
        ["card", "Write", "Write", "card", "Test", "Test"]
    );
}

#[test]
fn alias_in_custom_component_arguments() {
    // A component root receives the caller's binding arguments. The alias
    // spellings must behave exactly like the `item` spellings.
    let comps = [("Badge", r#"Text("static")"#)];
    let aliased = Harness::with_components(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Badge(@todo.title)
            Badge("@{todo.title}")
        } }"#,
        todos(),
        &comps,
    );
    let plain = Harness::with_components(
        r#"Column { ForEach(items: @state.todos, key: "id") {
            Badge(@item.title)
            Badge("@{item.title}")
        } }"#,
        todos(),
        &comps,
    );
    assert_eq!(plain.texts(), ["Write", "Write", "Test", "Test"]);
    assert_eq!(aliased.texts(), plain.texts());
}

#[test]
fn alias_inside_custom_component_body() {
    // A row component whose own body names the loop's alias.
    let h = Harness::with_components(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") { TodoRow() } }"#,
        todos(),
        &[(
            "TodoRow",
            r#"Row { Text("@{todo.title}") Text("@{todo.count + 10}") }"#,
        )],
    );
    assert_eq!(h.texts(), ["Write", "11", "Test", "14"]);
}

// ---------------------------------------------------------------------------
// Conditionals inside the loop
// ---------------------------------------------------------------------------

#[test]
fn alias_in_if_condition() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            If(condition: @todo.done) { Text("done: @{todo.title}") Else { Text("open: @{todo.title}") } }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["done: Write", "open: Test"]);
}

#[test]
fn alias_in_if_template_condition() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            If(condition: "@{todo.count > 2}") { Text("big @{todo.title}") }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["big Test"]);
}

#[test]
fn alias_in_when() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            When(value: @todo.title) {
                Case(match: "Write") { Text("W @{todo.id}") }
                Else { Text("other @{todo.id}") }
            }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["W 1", "other 2"]);
}

// ---------------------------------------------------------------------------
// Nested loops
// ---------------------------------------------------------------------------

#[test]
fn nested_aliases_read_both_scopes() {
    let mut state = todos();
    state["labels"] = json!([{"name": "x"}, {"name": "y"}]);
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            ForEach(items: @state.labels, as: "label") {
                Text("@{todo.title}/@{label.name}")
            }
        } }"#,
        state,
    );
    assert_eq!(h.texts(), ["Write/x", "Write/y", "Test/x", "Test/y"]);
}

#[test]
fn nested_inner_source_is_outer_alias() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            ForEach(items: @todo.tags, as: "tag") {
                Text("@{todo.title}:@{tag}")
            }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write:a", "Write:b", "Test:c"]);
}

#[test]
fn nested_inner_source_is_outer_alias_updates() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            ForEach(items: @todo.tags, as: "tag") { Text("@{todo.title}:@{tag}") }
        } }"#,
        todos(),
    );
    let mut next = todos();
    next["todos"][1]["tags"] = json!(["c", "d"]);
    h.update(next);
    assert_eq!(h.texts(), ["Write:a", "Write:b", "Test:c", "Test:d"]);
}

#[test]
fn nested_default_item_inner_source_from_outer_item() {
    // The neighbouring documented limitation: inner `@item.tags` against the
    // outer default `item`.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, key: "id") {
            ForEach(items: @item.tags) { Text("@{item}") }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["a", "b", "c"]);
}

#[test]
fn nested_inner_default_item_with_outer_alias() {
    // Outer aliased, inner default: `@{item}` is the inner row, the outer
    // row is still reachable through its alias.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            ForEach(items: @todo.tags) { Text("@{todo.title}-@{item}") }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write-a", "Write-b", "Test-c"]);
}

#[test]
fn list_shorthand_with_item_scoped_source() {
    // The other neighbouring documented limitation: `List(@item.entries)`.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, key: "id") {
            List(@item.tags) { Text("@{item}") }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["a", "b", "c"]);
}

#[test]
fn list_shorthand_with_alias_scoped_source() {
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            List(@todo.tags, as: "tag") { Text("@{todo.id}@{tag}") }
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["1a", "1b", "2c"]);
}

#[test]
fn same_alias_nested_shadows() {
    // An inner loop reusing the outer alias shadows it.
    let state = json!({"groups": [{"id": 1, "row": {"v": "outer"}, "rows": [{"v": "inner"}]}]});
    let h = Harness::new(
        r#"Column { ForEach(items: @state.groups, as: "r", key: "id") {
            ForEach(items: @r.rows, as: "r") { Text("@{r.v}") }
        } }"#,
        state,
    );
    assert_eq!(h.texts(), ["inner"]);
}

// ---------------------------------------------------------------------------
// Reactivity: updates, keyed reorder, sparse per-item edits
// ---------------------------------------------------------------------------

#[test]
fn alias_rows_follow_keyed_reorder_and_update() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.title}") Text(@todo.count)
        } }"#,
        todos(),
    );
    h.update(json!({"todos": [
        {"id": 2, "title": "Test",  "done": false, "count": 4, "tags": ["c"]},
        {"id": 1, "title": "Write", "done": true,  "count": 1, "tags": ["a", "b"]}
    ]}));
    assert_eq!(h.texts(), ["Test", "4", "Write", "1"]);
    assert_eq!(
        h.structural_patches(),
        0,
        "a pure reorder must move, not rebuild: {:?}",
        h.last
    );

    h.update(json!({"todos": [
        {"id": 2, "title": "Tested", "done": false, "count": 5, "tags": ["c"]},
        {"id": 1, "title": "Write",  "done": true,  "count": 1, "tags": ["a", "b"]},
        {"id": 3, "title": "Ship",   "done": false, "count": 0, "tags": []}
    ]}));
    assert_eq!(h.texts(), ["Tested", "5", "Write", "1", "Ship", "0"]);

    h.update(json!({"todos": [
        {"id": 3, "title": "Ship", "done": false, "count": 0, "tags": []}
    ]}));
    assert_eq!(h.texts(), ["Ship", "0"]);
}

#[test]
fn alias_sparse_item_field_edit_rerenders_row() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.title}") Text("@{todo.done ? 'done' : 'open'}") Text(@todo.count)
        } }"#,
        todos(),
    );
    h.update_sparse("todos.1.title", json!("Renamed"));
    assert_eq!(h.texts(), ["Write", "done", "1", "Renamed", "open", "4"]);
    h.update_sparse("todos.0.done", json!(false));
    assert_eq!(h.texts(), ["Write", "open", "1", "Renamed", "open", "4"]);
    h.update_sparse("todos.0.count", json!(9));
    assert_eq!(h.texts(), ["Write", "open", "9", "Renamed", "open", "4"]);
}

#[test]
fn alias_state_dependency_inside_row_rerenders() {
    let mut state = todos();
    state["selected"] = json!(1);
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{todo.id == state.selected ? 'sel' : '-'} @{todo.title}")
        } }"#,
        state,
    );
    assert_eq!(h.texts(), ["sel Write", "- Test"]);
    h.update(json!({"selected": 2}));
    assert_eq!(h.texts(), ["- Write", "sel Test"]);
}

// ---------------------------------------------------------------------------
// The default `item` name
// ---------------------------------------------------------------------------

#[test]
fn default_item_name_still_works() {
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.todos, key: "id") {
            Text("@{item.title}") Text(@item.count) Text("@{item.done ? 'y' : 'n'}")
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "1", "y", "Test", "4", "n"]);
    h.update_sparse("todos.0.title", json!("W2"));
    assert_eq!(h.texts(), ["W2", "1", "y", "Test", "4", "n"]);
}

#[test]
fn item_still_resolves_under_an_aliased_loop() {
    // Decision (kept for compatibility): `@{item.x}` is the row of the
    // enclosing loop whatever that loop's `as:` name is. An alias
    // adds a name; it does not take `item` away.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{item.title}") Text(@item.count)
        } }"#,
        todos(),
    );
    assert_eq!(h.texts(), ["Write", "1", "Test", "4"]);
}

#[test]
fn unknown_name_is_not_the_row() {
    // A name that is neither the alias nor `item` is left alone.
    let h = Harness::new(
        r#"Column { ForEach(items: @state.todos, as: "todo", key: "id") {
            Text("@{other.title}")
        } }"#,
        todos(),
    );
    assert_ne!(h.texts()[0], "Write");
}

#[test]
fn documented_nested_examples_render() {
    // hypen-docs guide/control-flow.mdx "Custom Item Variable Names" and the
    // hypen-ui skill's nested example: the inner source spelled through the
    // outer alias. (`@item.products` under `as: "category"` does not resolve
    // on this engine: a nested source reads `@item` only from a loop named
    // `item`.)
    let state = json!({"categories": [
        {"id": 1, "name": "Fruit", "products": [
            {"sku": "a", "name": "Apple", "price": 1},
            {"sku": "p", "name": "Pear", "price": 2}
        ]},
        {"id": 2, "name": "Veg", "products": [{"sku": "k", "name": "Kale", "price": 3}]}
    ]});
    let mut h = Harness::new(
        r#"Column { ForEach(items: @state.categories, as: "category", key: "id") {
            Column {
                Text("@{category.name}")
                ForEach(items: @category.products, as: "product", key: "sku") {
                    Row { Text(@product.name) Text("$@{product.price}") }
                }
            }
        } }"#,
        state,
    );
    assert_eq!(
        h.texts(),
        ["Fruit", "Apple", "$1", "Pear", "$2", "Veg", "Kale", "$3"]
    );
    h.update_sparse("categories.1.products.0.name", json!("Chard"));
    assert_eq!(h.texts()[6], "Chard");
}
