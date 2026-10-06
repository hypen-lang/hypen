//! Integration tests for the Option D cheap subset: transaction-scoped
//! (batch-stamped) animation.
//!
//! A state update carrying an animation context stamps the NEXT render_dirty
//! cycle: if that cycle emits patches, `Patch::BatchAnimation` is prepended
//! as the batch's FIRST patch and the stamp is cleared. No patches → no
//! stamp on the wire, and the stamp must not leak into a later cycle.

use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// Build an engine rendering `Text("@{state.label}")` under a primary
/// module whose state also carries an `unbound` key no node depends on.
/// Returns the engine plus the shared patch-collection buffer.
fn stamped_engine() -> (Engine, Arc<Mutex<Vec<Patch>>>) {
    let mut engine = Engine::new();

    let module =
        Module::new("TestModule").with_state_keys(vec!["label".to_string(), "unbound".to_string()]);
    engine.set_module(ModuleInstance::new(
        module,
        json!({"label": "a", "unbound": "z"}),
    ));

    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = collected.clone();
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });

    let ast = hypen_parser::parse_component(r#"Text("@{state.label}")"#).expect("parse");
    let ir = hypen_engine::ast_to_ir_node(&ast);
    engine.render_ir_node(&ir);
    collected.lock().unwrap().clear();

    (engine, collected)
}

fn take(collected: &Arc<Mutex<Vec<Patch>>>) -> Vec<Patch> {
    std::mem::take(&mut *collected.lock().unwrap())
}

#[test]
fn stamped_sparse_update_emits_prelude_first_then_clears() {
    let (mut engine, collected) = stamped_engine();

    // WHEN: a sparse update stamped with a bare curve string
    engine.update_state_sparse_with_animation(
        None,
        &["label".to_string()],
        &json!({"label": "b"}),
        Some(json!("spring")),
    );

    // THEN: BatchAnimation is the FIRST patch, carrying the normalized spec
    let patches = take(&collected);
    assert_eq!(patches.len(), 2, "prelude + SetProp expected: {patches:?}");
    assert!(
        matches!(
            &patches[0],
            Patch::BatchAnimation { spec } if *spec == json!({"curve": "spring", "duration": 250})
        ),
        "first patch must be the normalized BatchAnimation prelude: {:?}",
        patches[0]
    );
    assert!(
        matches!(&patches[1], Patch::SetProp { value, .. } if *value == json!("b")),
        "second patch must be the SetProp: {:?}",
        patches[1]
    );

    // AND: the stamp is consumed — the next unstamped update emits no prelude
    engine.update_state_sparse(None, &["label".to_string()], &json!({"label": "c"}));
    let patches = take(&collected);
    assert_eq!(patches.len(), 1, "unstamped update: {patches:?}");
    assert!(
        matches!(&patches[0], Patch::SetProp { .. }),
        "no prelude on an unstamped update: {:?}",
        patches[0]
    );
}

#[test]
fn stamped_full_update_emits_prelude_with_spec_object() {
    let (mut engine, collected) = stamped_engine();

    // WHEN: a full-patch update stamped with a spec object missing duration
    engine.update_state_with_animation(
        None,
        json!({"label": "b"}),
        Some(json!({"curve": "easeOut"})),
    );

    // THEN: prelude first, duration filled with the 250 default
    let patches = take(&collected);
    assert!(
        matches!(
            &patches[0],
            Patch::BatchAnimation { spec } if *spec == json!({"curve": "easeOut", "duration": 250})
        ),
        "prelude with filled duration expected first: {patches:?}"
    );
    assert!(patches[1..]
        .iter()
        .all(|p| !matches!(p, Patch::BatchAnimation { .. })));
}

#[test]
fn stamp_with_zero_dirty_nodes_emits_nothing_and_does_not_leak() {
    let (mut engine, collected) = stamped_engine();

    // WHEN: a stamped update to a path no node is bound to
    engine.update_state_sparse_with_animation(
        None,
        &["unbound".to_string()],
        &json!({"unbound": "y"}),
        Some(json!("spring")),
    );

    // THEN: state changed but the diff is empty — nothing on the wire
    assert!(
        take(&collected).is_empty(),
        "no patches → no stamp (no prelude-only batches)"
    );

    // AND: the discarded stamp must not resurface on a later unstamped update
    engine.update_state_sparse(None, &["label".to_string()], &json!({"label": "b"}));
    let patches = take(&collected);
    assert!(
        !patches.is_empty()
            && patches
                .iter()
                .all(|p| !matches!(p, Patch::BatchAnimation { .. })),
        "stale stamp leaked into a later cycle: {patches:?}"
    );
}

#[test]
fn no_op_stamped_update_never_stamps() {
    let (mut engine, collected) = stamped_engine();

    // WHEN: a stamped update that changes nothing (same value)
    engine.update_state_sparse_with_animation(
        None,
        &["label".to_string()],
        &json!({"label": "a"}),
        Some(json!("spring")),
    );
    assert!(take(&collected).is_empty(), "no-op update emits nothing");

    // AND: a later real-but-unstamped update stays unstamped
    engine.update_state_sparse(None, &["label".to_string()], &json!({"label": "b"}));
    let patches = take(&collected);
    assert!(
        !patches.is_empty()
            && patches
                .iter()
                .all(|p| !matches!(p, Patch::BatchAnimation { .. })),
        "a no-op dispatch must not stamp a later cycle: {patches:?}"
    );
}

#[test]
fn invalid_animation_spec_proceeds_unstamped() {
    let (mut engine, collected) = stamped_engine();

    // Unknown bare curve, and structurally-invalid specs: warn + unstamped,
    // never a hard error — the state update itself still applies.
    for (i, bad) in [json!("wobble"), json!(250), json!(["spring"])]
        .into_iter()
        .enumerate()
    {
        engine.update_state_sparse_with_animation(
            None,
            &["label".to_string()],
            &json!({ "label": format!("v{i}") }),
            Some(bad),
        );
        let patches = take(&collected);
        assert_eq!(patches.len(), 1, "update still renders: {patches:?}");
        assert!(
            matches!(&patches[0], Patch::SetProp { .. }),
            "invalid spec must not stamp: {:?}",
            patches[0]
        );
    }
}
