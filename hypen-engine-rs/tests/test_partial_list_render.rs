//! Tests for the index-narrow list re-render path.
//!
//! When a sparse state update names specific item indices
//! (`items.1.name`), the renderer reconciles only those children instead of
//! running the keyed pass over the whole list. These tests pin down: the
//! narrow pass produces exactly the touched row's patches; structural
//! changes in disguise (swap, growth, wholesale replacement) still fall
//! back to the full keyed pass and keep their structural patch shapes.

use hypen_engine::{
    ir::{Element, IRNode, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::Binding,
    reconcile::Patch,
    Engine, TemplateExpander,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

fn rows_list() -> Element {
    let mut leaf = Element::new("Text");
    leaf.props.insert(
        "0".to_string(),
        Value::Binding(Binding::item(vec!["name".to_string()])),
    );
    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(leaf));
    list
}

/// Build an engine with a rendered 3-row list and a patch collector.
/// The returned [`TemplateExpander`] has consumed the initial render's
/// batch (registering its template), so later batches can be lowered to
/// plain patches exactly as a non-template boundary would.
fn engine_with_rows(
    initial: serde_json::Value,
) -> (Engine, Arc<Mutex<Vec<Patch>>>, TemplateExpander) {
    let mut engine = Engine::new();
    let module = Module::new("TestModule");
    engine.set_module(ModuleInstance::new(module, initial));

    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });

    engine.render_ir_node(&IRNode::Element(rows_list()));
    let mut expander = TemplateExpander::new();
    let initial_batch = std::mem::take(&mut *collected.lock().unwrap());
    expander.expand(initial_batch);
    (engine, collected, expander)
}

fn three_rows() -> serde_json::Value {
    json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
        {"id": 3, "name": "C"},
    ]})
}

/// A sparse update naming one item's field patches exactly that row —
/// no creates, removes, or moves, and no patches touching other rows.
#[test]
fn sparse_item_edit_patches_only_that_row() {
    let (mut engine, patches, _) = engine_with_rows(three_rows());

    engine.update_state_sparse(
        None,
        &["items.1.name".to_string()],
        &json!({"items.1.name": "B2"}),
    );

    let batch = patches.lock().unwrap();
    assert!(
        !batch.is_empty(),
        "the edit must produce at least one patch"
    );
    let structural = batch
        .iter()
        .filter(|p| {
            matches!(
                p,
                Patch::Create { .. } | Patch::Remove { .. } | Patch::Move { .. }
            )
        })
        .count();
    assert_eq!(
        structural, 0,
        "an in-place item edit must be non-structural, got: {:?}",
        batch
    );
    assert!(
        batch.iter().any(|p| match p {
            Patch::SetProp { value, .. } => value == &json!("B2"),
            _ => false,
        }),
        "the new value must land in a SetProp, got: {:?}",
        batch
    );
    assert!(
        !batch.iter().any(|p| match p {
            Patch::SetProp { value, .. } => value == &json!("A") || value == &json!("C"),
            _ => false,
        }),
        "untouched rows must not re-emit their values, got: {:?}",
        batch
    );
}

/// A swap arrives as granular paths too (every differing field of both
/// indices) — but the identity (key) change at those indices must defeat
/// the narrow pass so the keyed pass emits Moves, preserving element
/// identity instead of rewriting content in place.
#[test]
fn swap_via_sparse_paths_still_moves() {
    let (mut engine, patches, _) = engine_with_rows(three_rows());

    // Swap rows 0 and 2, exactly as the SDK's diff would express it.
    engine.update_state_sparse(
        None,
        &[
            "items.0.id".to_string(),
            "items.0.name".to_string(),
            "items.2.id".to_string(),
            "items.2.name".to_string(),
        ],
        &json!({
            "items.0.id": 3, "items.0.name": "C",
            "items.2.id": 1, "items.2.name": "A",
        }),
    );

    let batch = patches.lock().unwrap();
    assert!(
        batch.iter().any(|p| matches!(p, Patch::Move { .. })),
        "a swap must reorder via Move patches, got: {:?}",
        batch
    );
    assert_eq!(
        batch
            .iter()
            .filter(|p| matches!(p, Patch::Create { .. } | Patch::Remove { .. }))
            .count(),
        0,
        "a swap must not create or remove nodes, got: {:?}",
        batch
    );
}

/// Growth arrives as a path naming a brand-new index; the child-count check
/// must defeat the narrow pass so the new row is actually created. The new
/// row travels as an Instantiate — lowering it through the expander must
/// yield the row's Create.
#[test]
fn growth_via_sparse_path_still_creates() {
    let (mut engine, patches, mut expander) = engine_with_rows(three_rows());

    engine.update_state_sparse(
        None,
        &["items.3".to_string()],
        &json!({"items.3": {"id": 4, "name": "D"}}),
    );

    let batch = expander.expand(std::mem::take(&mut *patches.lock().unwrap()));
    assert!(
        batch.iter().any(|p| match p {
            Patch::Create { props, .. } => props.get("0") == Some(&json!("D")),
            _ => false,
        }),
        "growth must create the new row, got: {:?}",
        batch
    );
}

/// A wholesale array replacement (path names the array itself) keeps the
/// full keyed pass: content updates land and removals are emitted.
#[test]
fn wholesale_replacement_still_full_pass() {
    let (mut engine, patches, _) = engine_with_rows(three_rows());

    engine.update_state_sparse(
        None,
        &["items".to_string()],
        &json!({"items": [
            {"id": 1, "name": "A"},
            {"id": 2, "name": "B2"},
        ]}),
    );

    let batch = patches.lock().unwrap();
    assert!(
        batch.iter().any(|p| matches!(p, Patch::Remove { .. })),
        "the dropped third row must be removed, got: {:?}",
        batch
    );
    assert!(
        batch.iter().any(|p| match p {
            Patch::SetProp { value, .. } => value == &json!("B2"),
            _ => false,
        }),
        "the changed row must update, got: {:?}",
        batch
    );
}

/// The compiled binding-map path: an item-dependent ternary template string
/// (the "selected row highlight" shape) must resolve through the fast path
/// with the same output the full reconcile produces.
#[test]
fn compiled_ternary_prop_updates_on_item_change() {
    let mut leaf = Element::new("Text");
    leaf.props.insert(
        "0".to_string(),
        Value::Binding(Binding::item(vec!["name".to_string()])),
    );
    let mut row = Element::new("Row");
    row.props.insert(
        "backgroundColor".to_string(),
        Value::Static(json!("@{item.selected ? '#001122' : '#ffffff'}")),
    );
    row.ir_children.push(IRNode::Element(leaf));

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children.push(IRNode::Element(row));

    let mut engine = Engine::new();
    let module = Module::new("TestModule");
    engine.set_module(ModuleInstance::new(
        module,
        json!({"items": [
            {"id": 1, "name": "A", "selected": false},
            {"id": 2, "name": "B", "selected": false},
        ]}),
    ));
    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });
    engine.render_ir_node(&IRNode::Element(list));
    collected.lock().unwrap().clear();

    engine.update_state_sparse(
        None,
        &["items.1.selected".to_string()],
        &json!({"items.1.selected": true}),
    );

    let batch = collected.lock().unwrap();
    assert!(
        batch.iter().any(|p| match p {
            Patch::SetProp { name, value, .. } =>
                name == "backgroundColor" && value == &json!("#001122"),
            _ => false,
        }),
        "the selected row's ternary background must flip, got: {:?}",
        batch
    );
    assert_eq!(
        batch
            .iter()
            .filter(|p| matches!(p, Patch::Create { .. } | Patch::Remove { .. } | Patch::Move { .. }))
            .count(),
        0,
        "a highlight toggle is non-structural, got: {:?}",
        batch
    );
}

/// Template instantiation is always on: list rows go over the wire as one
/// RegisterTemplate + per-row Instantiate instead of per-node Create/Insert
/// runs; ids and subs must cover every element and every dynamic prop.
#[test]
fn template_patches_always_emitted() {
    let mut engine = Engine::new();
    let module = Module::new("TestModule");
    engine.set_module(ModuleInstance::new(module, three_rows()));

    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });
    engine.render_ir_node(&IRNode::Element(rows_list()));

    let batch = collected.lock().unwrap();
    let registers = batch
        .iter()
        .filter(|p| matches!(p, Patch::RegisterTemplate { .. }))
        .count();
    let instantiates: Vec<_> = batch
        .iter()
        .filter_map(|p| match p {
            Patch::Instantiate { nodes, subs, .. } => Some((nodes.len(), subs.len())),
            _ => None,
        })
        .collect();
    assert_eq!(registers, 1, "one template registration, got: {:?}", batch);
    assert_eq!(instantiates.len(), 3, "one Instantiate per row, got: {:?}", batch);
    for (node_count, sub_count) in &instantiates {
        assert_eq!(*node_count, 1, "template has one element (Text leaf)");
        assert_eq!(*sub_count, 1, "the @item.name prop must arrive as a sub");
    }
    // Rows must NOT also arrive as plain Creates (the container itself still
    // does — it isn't a template instance).
    let creates = batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count();
    assert_eq!(creates, 1, "only the List container is a plain Create, got: {:?}", batch);
}

/// Nested ForEach: the inner per-row template is byte-identical across
/// outer rows, so ONE RegisterTemplate must cover every inner row. The
/// template id is content-addressed from the planned skeleton — unlike the
/// memo fingerprint, which (rightly) also covers the per-outer-row key
/// stamps substitution leaves on the inner template and would mint a fresh
/// id per outer row, growing every template store with rows ever seen.
#[test]
fn nested_foreach_registers_inner_template_once() {
    let mut engine = Engine::new();
    let module = Module::new("TestModule");
    engine.set_module(ModuleInstance::new(
        module,
        json!({
            "posts": [{"id": 1}, {"id": 2}, {"id": 3}],
            "tags": ["x", "y"],
        }),
    ));

    // List(@state.posts) { Column { List(@state.tags) { Text("static") } } }
    let mut inner_leaf = Element::new("Text");
    inner_leaf
        .props
        .insert("0".to_string(), Value::Static(json!("static")));
    let mut inner_list = Element::new("List");
    inner_list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["tags".to_string()])),
    );
    inner_list.ir_children.push(IRNode::Element(inner_leaf));
    let mut row = Element::new("Column");
    row.ir_children.push(IRNode::Element(inner_list));
    let mut outer = Element::new("List");
    outer.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["posts".to_string()])),
    );
    outer.ir_children.push(IRNode::Element(row));

    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });
    engine.render_ir_node(&IRNode::Element(outer));

    let batch = collected.lock().unwrap();
    let register_ids: Vec<&str> = batch
        .iter()
        .filter_map(|p| match p {
            Patch::RegisterTemplate { template_id, .. } => Some(template_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        register_ids.len(),
        1,
        "identical inner templates share one registration, got: {:?}",
        batch
    );
    let instantiates = batch
        .iter()
        .filter(|p| {
            matches!(p, Patch::Instantiate { template_id, .. } if template_id == register_ids[0])
        })
        .count();
    assert_eq!(
        instantiates, 6,
        "3 outer rows x 2 tags all instantiate the same template, got: {:?}",
        batch
    );
}

/// Differential: the collapsed wire, lowered through [`TemplateExpander`],
/// must carry exactly what the plain wire used to — per row a
/// Create (props including the substituted item value) immediately
/// followed by its Insert under the List container, in preorder.
#[test]
fn expanded_wire_matches_plain_create_runs() {
    let mut engine = Engine::new();
    let module = Module::new("TestModule");
    engine.set_module(ModuleInstance::new(module, three_rows()));

    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });
    engine.render_ir_node(&IRNode::Element(rows_list()));

    let mut expander = TemplateExpander::new();
    let batch = expander.expand(std::mem::take(&mut *collected.lock().unwrap()));

    assert!(
        !batch.iter().any(|p| matches!(
            p,
            Patch::RegisterTemplate { .. } | Patch::Instantiate { .. }
        )),
        "the expanded wire carries no template patches, got: {:?}",
        batch
    );

    // Container first: Create(List) then its Insert into "root".
    let list_id = match &batch[0] {
        Patch::Create {
            id, element_type, ..
        } => {
            assert_eq!(element_type, "List");
            id.clone()
        }
        other => panic!("expected the List container Create first, got {:?}", other),
    };
    match &batch[1] {
        Patch::Insert { parent_id, id, .. } => {
            assert_eq!(parent_id.as_ref(), "root");
            assert_eq!(id, &list_id);
        }
        other => panic!("expected the container Insert second, got {:?}", other),
    }

    // Then each row as an adjacent Create+Insert pair under the container,
    // in item order, with the item's value substituted into the props.
    assert_eq!(batch.len(), 8, "container pair + 3 row pairs, got: {:?}", batch);
    for (row, expected) in ["A", "B", "C"].iter().enumerate() {
        let base = 2 + row * 2;
        let row_id = match &batch[base] {
            Patch::Create {
                id,
                element_type,
                props,
                ..
            } => {
                assert_eq!(element_type, "Text");
                assert_eq!(
                    props.get("0"),
                    Some(&json!(expected)),
                    "row {} must carry its substituted item value",
                    row
                );
                id.clone()
            }
            other => panic!("expected row {} Create, got {:?}", row, other),
        };
        match &batch[base + 1] {
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                assert_eq!(parent_id, &list_id, "rows insert under the container");
                assert_eq!(id, &row_id, "Insert follows its own Create");
                assert!(before_id.is_none(), "creation appends");
            }
            other => panic!("expected row {} Insert, got {:?}", row, other),
        }
    }
}
