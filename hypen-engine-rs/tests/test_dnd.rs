//! Drag & drop — engine-side contract tests (Stage A1 of
//! `hypen-web/docs/dnd.md`).
//!
//! Covers, end to end through the parser: the `__dnd.*` lowering of the four
//! role applicators, `.bind` coexistence on a sortable/pinboard, header-less
//! `.states` on a DnD node, `__dnd.pinGroup` propagation, and — through the
//! engine's reconcile/update pipeline — `__dnd.key` stamping, the reserved
//! translate-binding injection and its reactivity.

use hypen_engine::ir::{IRNode, Value};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::tree::ResolvedProps;
use hypen_engine::reconcile::Patch;
use hypen_engine::{ast_to_ir_node, Engine};
use hypen_parser::parse_component;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn parse_to_element(input: &str) -> hypen_engine::Element {
    let component = parse_component(input).unwrap();
    match ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    }
}

fn static_json(element: &hypen_engine::Element, key: &str) -> serde_json::Value {
    match element.props.get(key) {
        Some(Value::Static(v)) => v.clone(),
        other => panic!("expected static prop {key}, got {other:?}"),
    }
}

/// First `ForEach` template element under `element`'s direct children.
fn foreach_template_root(element: &hypen_engine::Element) -> &hypen_engine::Element {
    for child in &element.ir_children {
        if let IRNode::ForEach { template, .. } = child {
            if let Some(IRNode::Element(root)) = template.first() {
                return root;
            }
        }
    }
    panic!("no ForEach template under {}", element.element_type);
}

// ============================================================================
// Lowering through the parser
// ============================================================================

#[test]
fn draggable_lowers_to_dnd_source_and_bindable_pieces() {
    let el = parse_to_element(
        r#"Card("x").draggable(group: "cards", handle: true, activation: press, payload: @item, enabled: @state.canDrag)"#,
    );
    assert_eq!(
        static_json(&el, "__dnd.source"),
        json!({"group": "cards", "handle": true, "activation": "press"})
    );
    assert!(matches!(el.props.get("__dnd.sourcePayload"), Some(Value::Binding(b)) if b.is_item()));
    assert!(
        matches!(el.props.get("__dnd.sourceEnabled"), Some(Value::Binding(b)) if b.is_state() && b.full_path() == "canDrag")
    );
    // Never a generic `draggable.<idx>` prop.
    assert!(el.props.keys().all(|k| !k.starts_with("draggable")));
}

#[test]
fn draggable_defaults_and_malformed_degrade() {
    let el = parse_to_element(r#"Card("x").draggable()"#);
    assert_eq!(
        static_json(&el, "__dnd.source"),
        json!({"group": null, "handle": false, "activation": "auto"})
    );
    assert!(!el.props.contains_key("__dnd.sourcePayload"));
    assert!(!el.props.contains_key("__dnd.sourceEnabled"));

    // Positional (ignored), unknown activation token, non-bool handle.
    let el = parse_to_element(r#"Card("x").draggable("cards", activation: warp, handle: 1)"#);
    assert_eq!(
        static_json(&el, "__dnd.source"),
        json!({"group": null, "handle": false, "activation": "auto"})
    );
}

#[test]
fn drop_zone_lowers_with_bound_id_and_enabled() {
    let el = parse_to_element(
        r#"Row().dropZone(group: "fs", id: @item.id, enabled: @item.isFolder, band: 0.3)"#,
    );
    assert_eq!(
        static_json(&el, "__dnd.zone"),
        json!({"group": "fs", "band": 0.3})
    );
    assert!(matches!(el.props.get("__dnd.zoneId"), Some(Value::Binding(b)) if b.is_item()));
    assert!(matches!(el.props.get("__dnd.zoneEnabled"), Some(Value::Binding(b)) if b.is_item()));

    let el = parse_to_element(r#"TrashZone().dropZone(group: "fs", id: "trash")"#);
    assert_eq!(static_json(&el, "__dnd.zoneId"), json!("trash"));
    assert_eq!(
        static_json(&el, "__dnd.zone"),
        json!({"group": "fs", "band": 0.5})
    );
    assert!(!el.props.contains_key("__dnd.zoneEnabled"));
}

#[test]
fn sortable_lowers_and_defaults_group_from_id() {
    let el = parse_to_element(r#"Column { Text("a") }.sortable(axis: x, group: "board")"#);
    assert_eq!(
        static_json(&el, "__dnd.sort"),
        json!({"group": "board", "axis": "x"})
    );

    // Group defaults to the node id (applied AFTER .sortable in the chain).
    let el = parse_to_element(r#"Column { Text("a") }.sortable().id("todo")"#);
    assert_eq!(
        static_json(&el, "__dnd.sort"),
        json!({"group": "todo", "axis": "y"})
    );

    // No id, no group → null (self-only sortable).
    let el = parse_to_element(r#"Column { Text("a") }.sortable(axis: y)"#);
    assert_eq!(
        static_json(&el, "__dnd.sort"),
        json!({"group": null, "axis": "y"})
    );
}

#[test]
fn sortable_with_bind_keeps_bind_prop() {
    let el = parse_to_element(
        r#"Column { ForEach(items: @state.tasks, key: "id") { Row().draggable() } }.sortable(axis: y).bind(@state.tasks)"#,
    );
    assert_eq!(
        static_json(&el, "__dnd.sort"),
        json!({"group": null, "axis": "y"})
    );
    // The existing `.bind` lowering is untouched: "bind" carries the path.
    assert_eq!(static_json(&el, "bind"), json!("tasks"));
    // And the template's draggable lowered inside the ForEach.
    let row = foreach_template_root(&el);
    assert!(row.props.contains_key("__dnd.source"));
    assert!(!row.props.contains_key("__dnd.pinGroup"));
}

#[test]
fn pinboard_user_field_mode_with_bind() {
    let el = parse_to_element(
        r#"Stack { ForEach(items: @state.seats, key: "id") { Seat().translateX(@item.x).translateY(@item.y).draggable() } }.pinboard(x: "x", y: "y", grid: 8).bind(@state.seats)"#,
    );
    assert_eq!(
        static_json(&el, "__dnd.pin"),
        json!({"group": null, "xKey": "x", "yKey": "y", "grid": 8.0, "bounds": "clamp", "units": "px"})
    );
    assert_eq!(static_json(&el, "bind"), json!("seats"));
    // User-field mode: NO pin-group propagation.
    let seat = foreach_template_root(&el);
    assert!(!seat.props.contains_key("__dnd.pinGroup"));
}

#[test]
fn pinboard_reserved_mode_propagates_pin_group_through_foreach() {
    let el = parse_to_element(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Row { Note().draggable() } } }.pinboard(group: "board", bounds: free, units: fraction)"#,
    );
    assert_eq!(
        static_json(&el, "__dnd.pin"),
        json!({"group": "board", "xKey": "x", "yKey": "y", "grid": null, "bounds": "free", "units": "fraction"})
    );
    // Stamped on the nested draggable (below the template root), not on the
    // non-draggable Row wrapper.
    let row = foreach_template_root(&el);
    assert!(!row.props.contains_key("__dnd.pinGroup"));
    let IRNode::Element(note) = &row.ir_children[0] else {
        panic!("expected Note element");
    };
    assert_eq!(static_json(note, "__dnd.pinGroup"), json!("board"));
}

#[test]
fn pinboard_group_defaults_to_id_argument() {
    let el = parse_to_element(
        r#"Stack(id: "board") { ForEach(items: @state.notes) { Note().draggable() } }.pinboard()"#,
    );
    assert_eq!(static_json(&el, "__dnd.pin")["group"], json!("board"));
    let note = foreach_template_root(&el);
    assert_eq!(static_json(note, "__dnd.pinGroup"), json!("board"));
}

#[test]
fn pinboard_reserved_mode_without_group_is_dropped() {
    let el = parse_to_element(
        r#"Stack { ForEach(items: @state.notes) { Note().draggable() } }.pinboard(grid: 4)"#,
    );
    assert!(!el.props.contains_key("__dnd.pin"));
    let note = foreach_template_root(&el);
    assert!(note.props.contains_key("__dnd.source"));
    assert!(!note.props.contains_key("__dnd.pinGroup"));
}

#[test]
fn nested_pinboard_nearest_ancestor_wins() {
    let el = parse_to_element(
        r#"Stack { Stack { ForEach(items: @state.notes) { Note().draggable() } }.pinboard(group: "inner") }.pinboard(group: "outer")"#,
    );
    let IRNode::Element(inner) = &el.ir_children[0] else {
        panic!("expected inner Stack");
    };
    let note = foreach_template_root(inner);
    assert_eq!(static_json(note, "__dnd.pinGroup"), json!("inner"));
}

#[test]
fn event_applicators_flow_through_generic_path() {
    let el = parse_to_element(
        r#"Column { Text("a") }.sortable().onSort(@actions.reorder).onDragOver(@actions.peek, dwell: 200)"#,
    );
    assert!(matches!(el.props.get("onSort.0"), Some(Value::Action(a)) if a == "reorder"));
    assert!(matches!(el.props.get("onDragOver.0"), Some(Value::Action(a)) if a == "peek"));
    assert_eq!(static_json(&el, "onDragOver.dwell"), json!(200.0));
}

// ============================================================================
// Header-less `.states` (§2.1)
// ============================================================================

#[test]
fn headerless_states_on_draggable_is_runtime_driven() {
    let el = parse_to_element(
        r##"Card("x").opacity(1).draggable().states { onState(lifted).opacity(0.6).scale(1.04) onState(over).backgroundColor("#eee") }"##,
    );
    // Base props stay plain statics (no StateSwitch).
    assert_eq!(static_json(&el, "opacity.0"), json!(1.0));
    assert!(!el.props.contains_key("scale.0"));
    // Static runtime marker + materialized poses.
    assert_eq!(
        static_json(&el, "__anim.states"),
        json!({"label": null, "runtime": true})
    );
    assert_eq!(
        static_json(&el, "__anim.statePoses"),
        json!({
            "lifted": {"opacity.0": 0.6, "scale.0": 1.04},
            "over": {"backgroundColor.0": "#eee"}
        })
    );
    // Synthesized transition scoped to the animatable overridden props.
    let transition = static_json(&el, "__anim.transition");
    assert_eq!(
        transition["props"],
        json!(["opacity", "scale", "backgroundColor"])
    );
    assert_eq!(transition["duration"], json!(250));
}

#[test]
fn headerless_states_without_dnd_props_still_ignored() {
    let el = parse_to_element(r#"Card("x").opacity(1).states { onState(lifted).opacity(0.6) }"#);
    assert!(!el.props.contains_key("__anim.states"));
    assert!(!el.props.contains_key("__anim.statePoses"));
    assert_eq!(static_json(&el, "opacity.0"), json!(1.0));
}

#[test]
fn state_driven_states_on_draggable_still_switch() {
    let el = parse_to_element(
        r#"Card("x").opacity(1).draggable().states(@state.phase) { onState(hot).opacity(0.5) }"#,
    );
    assert!(
        matches!(el.props.get("opacity.0"), Some(Value::StateSwitch { path, .. }) if path == "phase")
    );
    assert!(matches!(
        el.props.get("__anim.states"),
        Some(Value::StateSwitch { .. })
    ));
    assert!(!el.props.contains_key("__anim.statePoses"));
}

// ============================================================================
// Item expansion + reactivity through the engine
// ============================================================================

fn collect_patches() -> (
    Arc<Mutex<Vec<Patch>>>,
    impl Fn(&[Patch]) + Send + Sync + 'static,
) {
    let patches: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&patches);
    let callback = move |ps: &[Patch]| {
        capture.lock().unwrap().extend_from_slice(ps);
    };
    (patches, callback)
}

fn find_create_with_prop<'a>(
    patches: &'a [Patch],
    prop: &str,
    value: &serde_json::Value,
) -> Option<(&'a str, &'a ResolvedProps)> {
    patches.iter().find_map(|p| match p {
        Patch::Create { id, props, .. } if props.get(prop) == Some(value) => Some((&**id, props)),
        _ => None,
    })
}

fn render(source: &str, state: serde_json::Value) -> (Engine, Arc<Mutex<Vec<Patch>>>) {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("App"), state));
    let (patches, callback) = collect_patches();
    engine.set_render_callback(callback);
    let ir = ast_to_ir_node(&parse_component(source).unwrap());
    engine.render_ir_node(&ir);
    (engine, patches)
}

#[test]
fn foreach_expansion_stamps_dnd_key_from_item_key() {
    let (_engine, patches) = render(
        r#"Column { ForEach(items: @state.tasks, key: "id") { Row { Text("@{item.title}").draggable() } } }.sortable().bind(@state.tasks)"#,
        json!({"tasks": [{"id": "t1", "title": "A"}, {"id": "t2", "title": "B"}]}),
    );
    let patches = patches.lock().unwrap();
    for key in ["t1", "t2"] {
        let (_, props) = find_create_with_prop(&patches, "__dnd.key", &json!(key))
            .unwrap_or_else(|| panic!("no Create carrying __dnd.key = {key}: {patches:#?}"));
        assert!(props.contains_key("__dnd.source"));
        // Sortable (no pinboard): no translate injection.
        assert!(!props.contains_key("translateX.0"));
    }
    // Keys never land on non-draggable nodes.
    let stray = patches.iter().any(|p| matches!(p, Patch::Create { element_type, props, .. } if element_type == "Row" && props.contains_key("__dnd.key")));
    assert!(!stray, "__dnd.key must only be stamped on the draggable");
}

#[test]
fn foreach_expansion_without_id_uses_positional_key() {
    let (_engine, patches) = render(
        r#"Column { ForEach(items: @state.tags) { Chip("@{item}").draggable() } }.sortable().bind(@state.tags)"#,
        json!({"tags": ["x", "y"]}),
    );
    let patches = patches.lock().unwrap();
    assert!(find_create_with_prop(&patches, "__dnd.key", &json!("item-0")).is_some());
    assert!(find_create_with_prop(&patches, "__dnd.key", &json!("item-1")).is_some());
}

#[test]
fn reserved_pinboard_injects_translate_bindings_and_reacts_to_state() {
    let (mut engine, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note("@{item.text}").draggable() } }.pinboard(group: "board")"#,
        json!({
            "notes": [{"id": "n1", "text": "one"}, {"id": "n2", "text": "two"}],
            "__dnd": {"board": {"n1": {"x": 40, "y": 60}}}
        }),
    );

    // Initial render: n1 resolves its reserved position, n2 has none yet —
    // the injected binding resolves to JSON null (renderers treat a null
    // translate as 0).
    let n1_id = {
        let patches = patches.lock().unwrap();
        let (n1_id, n1) =
            find_create_with_prop(&patches, "__dnd.key", &json!("n1")).expect("n1 Create");
        assert_eq!(n1.get("translateX.0"), Some(&json!(40)));
        assert_eq!(n1.get("translateY.0"), Some(&json!(60)));
        assert_eq!(n1.get("__dnd.pinGroup"), Some(&json!("board")));
        let (_, n2) =
            find_create_with_prop(&patches, "__dnd.key", &json!("n2")).expect("n2 Create");
        assert_eq!(n2.get("translateX.0"), Some(&json!(null)));
        assert_eq!(n2.get("translateY.0"), Some(&json!(null)));
        n1_id.to_string()
    };
    patches.lock().unwrap().clear();

    // A `__hypen_pin` write lands on the reserved path: the injected
    // bindings must have registered as dependencies so exactly that node
    // re-renders with SetProp translateX/translateY.
    engine.update_state_sparse(
        None,
        &[
            "__dnd.board.n1.x".to_string(),
            "__dnd.board.n1.y".to_string(),
        ],
        &json!({"__dnd.board.n1.x": 120, "__dnd.board.n1.y": 80}),
    );
    let patches = patches.lock().unwrap();
    let set_x = patches.iter().any(|p| matches!(p, Patch::SetProp { id, name, value } if **id == *n1_id && name == "translateX.0" && value == &json!(120)));
    let set_y = patches.iter().any(|p| matches!(p, Patch::SetProp { id, name, value } if **id == *n1_id && name == "translateY.0" && value == &json!(80)));
    assert!(
        set_x,
        "expected SetProp translateX.0 = 120 on n1: {patches:#?}"
    );
    assert!(
        set_y,
        "expected SetProp translateY.0 = 80 on n1: {patches:#?}"
    );
    assert!(
        !patches.iter().any(|p| matches!(p, Patch::Create { .. })),
        "a pin write must not rebuild rows: {patches:#?}"
    );
}

#[test]
fn reserved_pinboard_first_position_for_unpinned_item_flows_as_set_prop() {
    let (mut engine, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note("@{item.text}").draggable() } }.pinboard(group: "board")"#,
        json!({"notes": [{"id": "n1", "text": "one"}]}),
    );
    let n1_id = {
        let patches = patches.lock().unwrap();
        let (id, props) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).expect("n1");
        assert_eq!(props.get("translateX.0"), Some(&json!(null)));
        id.to_string()
    };
    patches.lock().unwrap().clear();

    engine.update_state(
        None,
        json!({
            "notes": [{"id": "n1", "text": "one"}],
            "__dnd": {"board": {"n1": {"x": 5, "y": 7}}}
        }),
    );
    let patches = patches.lock().unwrap();
    assert!(
        patches.iter().any(|p| matches!(p, Patch::SetProp { id, name, value } if **id == *n1_id && name == "translateX.0" && value == &json!(5))),
        "expected SetProp translateX.0 = 5: {patches:#?}"
    );
    assert!(
        patches.iter().any(|p| matches!(p, Patch::SetProp { id, name, value } if **id == *n1_id && name == "translateY.0" && value == &json!(7))),
        "expected SetProp translateY.0 = 7: {patches:#?}"
    );
}

#[test]
fn author_translate_is_not_overridden_by_injection() {
    let (_engine, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note().translateX(12).draggable() } }.pinboard(group: "board")"#,
        json!({
            "notes": [{"id": "n1"}],
            "__dnd": {"board": {"n1": {"x": 40, "y": 60}}}
        }),
    );
    let patches = patches.lock().unwrap();
    let (_, n1) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).expect("n1");
    assert_eq!(n1.get("translateX.0"), Some(&json!(12.0)));
    assert_eq!(n1.get("translateY.0"), Some(&json!(60)));
}

// ============================================================================
// Cross-SDK conformance fixtures (`engine-compatibility-tests/fixtures/dnd/`)
// ============================================================================
//
// The DSL → `__dnd.*` lowering fixtures under `fixtures/dnd/` use the shared
// `test-case.schema.json` shape and are replayed by every runner in
// `engine-compatibility-tests/runners/`. This driver replays the subset of
// that schema the DnD fixtures use through the crate's own `Engine`, so
// `cargo test` in this crate turns red the moment the engine's wire output
// drifts from what the fixtures pin (the precedent is
// `anim.rs::whitelist_matches_scoped_props_conformance_fixture`). The
// `path-move.json` state-transform fixture in the same directory is driven
// by `portable::path::tests::move_matches_dnd_conformance_fixture`.

mod dnd_fixtures {
    use hypen_engine::lifecycle::{Module, ModuleInstance};
    use hypen_engine::reconcile::Patch;
    use hypen_engine::{ast_to_ir_node, Engine, TemplateExpander};
    use hypen_parser::parse_component;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine-compatibility-tests/fixtures/dnd")
    }

    /// Every `*.json` in the directory that is a `test-case.schema.json`
    /// fixture (has an `input` block). Skips `path-move.json` and any other
    /// state-transform fixture (`function` key).
    fn lowering_fixtures() -> Vec<(String, Value)> {
        let mut out: Vec<(String, Value)> = std::fs::read_dir(fixtures_dir())
            .expect("fixtures/dnd readable")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .filter_map(|p| {
                let text = std::fs::read_to_string(&p).expect("fixture readable");
                let v: Value = serde_json::from_str(&text)
                    .unwrap_or_else(|e| panic!("{}: not JSON: {e}", p.display()));
                v.get("input")
                    .is_some()
                    .then(|| (p.file_name().unwrap().to_string_lossy().into_owned(), v))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// `100` == `100.0`, objects need equal key sets (same as the compat
    /// runners' `json_values_equal`).
    fn json_eq(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len()
                    && x.iter()
                        .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
            }
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(v, w)| json_eq(v, w))
            }
            _ => a == b,
        }
    }

    fn patch_type(p: &Value) -> &str {
        p["type"].as_str().unwrap_or("")
    }

    fn matches(actual: &Value, expected: &Value) -> bool {
        if patch_type(actual) != expected["type"].as_str().unwrap_or("") {
            return false;
        }
        if let Some(et) = expected.get("elementType") {
            if actual.get("elementType") != Some(et) {
                return false;
            }
        }
        let props = actual.get("props");
        if let Some(Value::Object(want)) = expected.get("props") {
            for (k, v) in want {
                // `null` in the fixture means PRESENT with explicit null.
                match props.and_then(|p| p.get(k)) {
                    Some(av) if json_eq(av, v) => {}
                    _ => return false,
                }
            }
        }
        if let Some(Value::Array(absent)) = expected.get("absentProps") {
            if absent
                .iter()
                .any(|k| props.and_then(|p| p.get(k.as_str().unwrap())).is_some())
            {
                return false;
            }
        }
        if let Some(name) = expected.get("name") {
            if actual.get("name") != Some(name) {
                return false;
            }
        }
        if let Some(value) = expected.get("value") {
            match actual.get("value") {
                Some(av) if json_eq(av, value) => {}
                _ => return false,
            }
        }
        true
    }

    fn assert_step(name: &str, step: &str, patches: &[Value], spec: &Value, top_level: bool) {
        // Top-level `expected` uses patchCount/patchTypes/patches; steps use
        // the `expected`-prefixed names plus forbiddenPatchTypes.
        let (count_key, types_key, patches_key) = if top_level {
            ("patchCount", "patchTypes", "patches")
        } else {
            (
                "expectedPatchCount",
                "expectedPatchTypes",
                "expectedPatches",
            )
        };
        if let Some(n) = spec[count_key].as_u64() {
            assert_eq!(
                patches.len() as u64,
                n,
                "[{name}] {step}: patch count\n{patches:#?}"
            );
        }
        if let Some(types) = spec[types_key].as_array() {
            let actual: Vec<&str> = patches.iter().map(patch_type).collect();
            let want: Vec<&str> = types.iter().map(|t| t.as_str().unwrap()).collect();
            assert_eq!(actual, want, "[{name}] {step}: patch types");
        }
        if let Some(expected) = spec[patches_key].as_array() {
            let mut used = vec![false; patches.len()];
            for e in expected {
                let found = patches
                    .iter()
                    .enumerate()
                    .find(|(i, a)| !used[*i] && matches(a, e));
                match found {
                    Some((i, _)) => used[i] = true,
                    None => panic!("[{name}] {step}: no patch matches {e:#}\nActual: {patches:#?}"),
                }
            }
        }
        if let Some(forbidden) = spec["forbiddenPatchTypes"].as_array() {
            for f in forbidden {
                let f = f.as_str().unwrap();
                assert!(
                    !patches.iter().any(|p| patch_type(p) == f),
                    "[{name}] {step}: forbidden patch type {f:?} emitted\n{patches:#?}"
                );
            }
        }
    }

    fn run(name: &str, fixture: &Value) {
        let input = &fixture["input"];
        let source = input["source"].as_str().expect("input.source");
        let state = input
            .get("initialState")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let module_name = input["module"]["name"].as_str().unwrap_or("TestModule");

        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new(module_name), state));
        // Template-shaped rows arrive as RegisterTemplate/Instantiate on the
        // raw stream; fixtures pin the plain Create/Insert wire, so lower
        // each batch through a session-lifetime expander like the runners.
        let collected: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);
        let expander = Mutex::new(TemplateExpander::new());
        engine.set_render_callback(move |patches: &[Patch]| {
            let expanded = expander.lock().unwrap().expand(patches.to_vec());
            sink.lock()
                .unwrap()
                .extend(expanded.iter().map(|p| serde_json::to_value(p).unwrap()));
        });
        let render = |engine: &mut Engine| {
            let ir = ast_to_ir_node(
                &parse_component(source).unwrap_or_else(|e| panic!("[{name}] parse: {e:?}")),
            );
            engine.render_ir_node(&ir);
        };

        if let Some(steps) = fixture["steps"].as_array() {
            for (i, step) in steps.iter().enumerate() {
                collected.lock().unwrap().clear();
                let label = step["description"].as_str().unwrap_or("step");
                match step["action"].as_str() {
                    Some("initialRender") => render(&mut engine),
                    Some("updateState") => {
                        let new_values = step["stateChange"]["newValues"].clone();
                        engine.update_state(None, new_values);
                    }
                    other => panic!("[{name}] step {i}: unsupported action {other:?}"),
                }
                let patches = collected.lock().unwrap();
                assert_step(name, label, &patches, step, false);
            }
        } else {
            render(&mut engine);
            let patches = collected.lock().unwrap();
            assert_step(name, "single", &patches, &fixture["expected"], true);
        }
    }

    #[test]
    fn dnd_lowering_fixtures_match_engine_output() {
        let fixtures = lowering_fixtures();
        assert!(
            fixtures.len() >= 10,
            "expected the DnD lowering fixtures, found {}",
            fixtures.len()
        );
        for (file, fixture) in &fixtures {
            assert_eq!(fixture["category"], json!("dnd"), "{file}: category");
            run(file, fixture);
        }
    }
}

#[test]
fn custom_fractional_reserved_positions_keep_fields_and_units_through_updates() {
    let (mut engine, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note().draggable() } }.pinboard(group: "board", x: "left", y: "top", units: fraction)"#,
        json!({"notes":[{"id":"n1"}],"__dnd":{"board":{"n1":{"left":0.5,"top":0.25}}}}),
    );
    {
        let patches = patches.lock().unwrap();
        let (_, props) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).unwrap();
        assert_eq!(props.get("__dnd.pinX"), Some(&json!(0.5)));
        assert_eq!(props.get("__dnd.pinY"), Some(&json!(0.25)));
        assert!(!props.contains_key("translateX.0"));
    }
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({"__dnd":{"board":{"n1":{"left":0.75,"top":0.1}}}}),
    );
    let patches = patches.lock().unwrap();
    assert!(patches.iter().any(|p| matches!(p, Patch::SetProp { name, value, .. } if name == "__dnd.pinX" && value == &json!(0.75))));
    assert!(!patches
        .iter()
        .any(|p| matches!(p, Patch::Create { .. } | Patch::Remove { .. })));
}

#[test]
fn custom_pixel_positions_read_the_same_fields_the_host_writes() {
    let (_, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note().draggable() } }.pinboard(group: "board", x: "left", y: "top")"#,
        json!({"notes":[{"id":"n1"}],"__dnd":{"board":{"n1":{"left":120,"top":80}}}}),
    );
    let patches = patches.lock().unwrap();
    let (_, props) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).unwrap();
    assert_eq!(props.get("translateX.0"), Some(&json!(120)));
    assert_eq!(props.get("translateY.0"), Some(&json!(80)));
}

#[test]
fn bound_fractional_positions_use_item_fields_and_preserve_explicit_axes() {
    let (mut engine, patches) = render(
        r#"Stack { ForEach(items: @state.notes, key: "id") { Note().translateX(12).draggable() } }.pinboard(x: "left", y: "top", units: fraction).bind(@state.notes)"#,
        json!({"notes":[{"id":"n1","left":0.5,"top":0.25}]}),
    );
    {
        let patches = patches.lock().unwrap();
        let (_, props) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).unwrap();
        assert_eq!(props.get("translateX.0"), Some(&json!(12.0)));
        assert!(!props.contains_key("__dnd.pinX"));
        assert_eq!(props.get("__dnd.pinY"), Some(&json!(0.25)));
    }
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({"notes":[{"id":"n1","left":0.5,"top":0.75}]}));
    assert!(patches.lock().unwrap().iter().any(|p| matches!(p, Patch::SetProp { name, value, .. } if name == "__dnd.pinY" && value == &json!(0.75))));
}

#[test]
fn outer_fraction_board_does_not_capture_an_inner_pixel_bound_board() {
    let (_, patches) = render(
        r#"Stack { Stack { ForEach(items: @state.notes, key: "id") { Note().draggable() } }.pinboard(group: "inner").bind(@state.notes) }.pinboard(group: "outer", units: fraction)"#,
        json!({"notes":[{"id":"n1","x":12,"y":15}]}),
    );
    let patches = patches.lock().unwrap();
    let (_, props) = find_create_with_prop(&patches, "__dnd.key", &json!("n1")).unwrap();
    assert!(!props.contains_key("__dnd.pinGroup"));
    assert!(!props.contains_key("__dnd.pinX"));
    assert!(!props.contains_key("translateX.0"));
}
