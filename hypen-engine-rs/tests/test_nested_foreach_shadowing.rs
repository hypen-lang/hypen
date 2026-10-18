//! Nested ForEach loops that share the default iteration name `item`.
//!
//! The inner loop's `item` must shadow the outer one inside the inner
//! template; the outer row stays reachable through an explicit `as:` name.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

fn render(source: &str, state: &serde_json::Value) -> (InstanceTree, DependencyGraph, Vec<Patch>) {
    let ir = ast_to_ir_node(&parse_component(source).unwrap());
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let patches = reconcile_ir(&mut tree, &ir, None, state, &mut deps);
    let patches = hypen_engine::TemplateExpander::new().expand(patches);
    (tree, deps, patches)
}

fn text_props(patches: &[Patch]) -> Vec<serde_json::Value> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create {
                element_type,
                props,
                ..
            } if element_type == "Text" => props.get("0").cloned(),
            _ => None,
        })
        .collect()
}

fn groups() -> serde_json::Value {
    json!({ "groups": [
        { "id": "g1", "name": "Fruit", "items": [
            { "id": "a", "name": "Apple" },
            { "id": "b", "name": "Pear" }
        ]},
        { "id": "g2", "name": "Veg", "items": [
            { "id": "c", "name": "Kale" }
        ]}
    ]})
}

#[test]
fn inner_default_item_shadows_outer_default_item() {
    let (_, _, patches) = render(
        r#"Column {
            ForEach(items: @state.groups, key: "id") {
                Column {
                    Text("@{item.name}")
                    ForEach(items: @item.items, key: "id") {
                        Text("@{item.name}")
                    }
                }
            }
        }"#,
        &groups(),
    );
    assert_eq!(
        text_props(&patches),
        vec![
            json!("Fruit"),
            json!("Apple"),
            json!("Pear"),
            json!("Veg"),
            json!("Kale"),
        ],
        "inner @item must be the inner element, not the outer group"
    );
}

#[test]
fn outer_item_reachable_by_explicit_name_under_default_inner() {
    let (_, _, patches) = render(
        r#"Column {
            ForEach(items: @state.groups, key: "id", as: "group") {
                Column {
                    ForEach(items: @group.items, key: "id") {
                        Text("@{group.name}/@{item.name}")
                    }
                }
            }
        }"#,
        &groups(),
    );
    assert_eq!(
        text_props(&patches),
        vec![json!("Fruit/Apple"), json!("Fruit/Pear"), json!("Veg/Kale")]
    );
}

#[test]
fn inner_default_item_shadows_in_conditionals_and_bare_item() {
    // Shadowing must hold for every reference form: a bare `@{item}`, an
    // `If` condition, and nested control flow inside the inner template.
    let state = json!({ "rows": [
        { "id": "r1", "cells": ["x", "y"] }
    ]});
    let (_, _, patches) = render(
        r#"Column {
            ForEach(items: @state.rows, key: "id") {
                Row {
                    ForEach(items: @item.cells) {
                        If(@item) { Text("@{item}") }
                    }
                }
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!("x"), json!("y")]);
}

#[test]
fn shadowing_survives_state_updates() {
    use hypen_engine::lifecycle::{Module, ModuleInstance};
    use hypen_engine::Engine;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("M"), groups()));
    let sink = Arc::new(Mutex::new(Vec::new()));
    let s = sink.clone();
    engine.set_render_callback(move |p| s.lock().unwrap().extend_from_slice(p));
    let src = r#"Column {
        ForEach(items: @state.groups, key: "id") {
            Column {
                ForEach(items: @item.items, key: "id") {
                    Text("@{item.name}")
                }
            }
        }
    }"#;
    engine.render_ir_node(&ast_to_ir_node(&parse_component(src).unwrap()));
    sink.lock().unwrap().clear();

    let mut next = groups();
    next["groups"][0]["items"][0]["name"] = json!("Apricot");
    next["groups"][0]["name"] = json!("Fruits");
    engine.update_state(None, next);

    let patches = hypen_engine::TemplateExpander::new().expand(sink.lock().unwrap().clone());
    let values: Vec<serde_json::Value> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::SetProp { value, .. } => Some(value.clone()),
            Patch::Create { props, .. } => props.get("0").cloned(),
            _ => None,
        })
        .collect();
    assert!(values.contains(&json!("Apricot")), "{patches:?}");
    assert!(
        !values.contains(&json!("Fruits")),
        "the outer group's name must never reach an inner row: {patches:?}"
    );
}
