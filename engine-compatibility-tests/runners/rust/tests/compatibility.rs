//! Rust compatibility test runner for the Hypen engine.
//!
//! Loads JSON fixtures from `engine-compatibility-tests/fixtures/` and runs them
//! against the Rust engine (hypen-engine + hypen-parser).
//!
//! Unlike the Go and TypeScript runners, the Rust runner has direct access to
//! both the parser and engine, so it can test ALL categories: rendering, state,
//! reconciliation, actions, control-flow, and lifecycle.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hypen_engine::{Engine, IRNode, Module, ModuleInstance, Patch, TemplateExpander};
use serde::Deserialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Fixture data structures (mirrors the JSON schema)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TestCase {
    name: String,
    #[allow(dead_code)]
    description: String,
    category: String,
    #[allow(dead_code)]
    priority: Option<String>,
    input: TestInput,
    expected: Option<Expected>,
    steps: Option<Vec<Step>>,
    skip: Option<Skip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestInput {
    source: String,
    initial_state: Option<Value>,
    module: Option<ModuleConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModuleConfig {
    name: String,
    actions: Option<Vec<String>>,
    state_keys: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    patches: Option<Vec<ExpectedPatch>>,
    patch_count: Option<usize>,
    patch_types: Option<Vec<String>>,
    strict_patch_order: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    description: Option<String>,
    action: String,
    source: Option<String>,
    state_change: Option<StateChange>,
    dispatch_action: Option<DispatchAction>,
    /// Optional batch-animation context for this step's state update
    /// (Option D): a spec object or bare curve string, forwarded to
    /// `update_state_with_animation` so a changed-state render cycle is
    /// prefixed with a `batchAnimation` prelude.
    animation: Option<Value>,
    expected_patches: Option<Vec<ExpectedPatch>>,
    expected_patch_count: Option<usize>,
    expected_patch_types: Option<Vec<String>>,
    strict_patch_order: Option<bool>,
    forbidden_patch_types: Option<Vec<String>>,
    expected_state: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateChange {
    #[allow(dead_code)]
    paths: Vec<String>,
    new_values: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchAction {
    name: String,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedPatch {
    #[serde(rename = "type")]
    patch_type: String,
    element_type: Option<String>,
    props: Option<HashMap<String, Value>>,
    /// Prop keys that must NOT be present on the matched patch's props.
    /// Pins omission contracts (e.g. an invalid `.animate` preset must lower
    /// to no `__anim.animate` prop AND leave no raw `animate.0` passthrough).
    absent_props: Option<Vec<String>>,
    name: Option<String>,
    value: Option<Value>,
    /// Requires the matched patch's `value` to be EXPLICIT JSON `null` on
    /// the wire. Needed because `"value": null` in a fixture deserializes to
    /// the same `None` as omitting the key entirely (which matches ANY
    /// value) — null contracts (e.g. `__anim.states` nulling its label on
    /// fallback) are otherwise unassertable.
    value_is_null: Option<bool>,
    #[allow(dead_code)]
    text: Option<String>,
    /// Accessibility semantics block on `create`/`setSemantics` patches.
    /// Matched as a complete object (not partial) — the fixture pins the
    /// exact wire format, so an extra or missing field is a mismatch.
    semantics: Option<Value>,
    /// Exit-animation flag on `remove` patches. `true` requires the flag on
    /// the wire; `false` requires it absent or false (the flag is
    /// skip-serialized when false, so absence is the non-animated wire form).
    transition: Option<bool>,
    /// Batch-animation spec on `batchAnimation` patches. Matched as a
    /// complete object (exact equality) — the fixture pins the normalized
    /// wire spec, so an extra or missing field is a mismatch.
    spec: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct Skip {
    #[allow(dead_code)]
    reason: Option<String>,
    sdks: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

fn fixtures_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("../../fixtures")
}

fn find_fixtures(dir: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    if !dir.exists() {
        return results;
    }
    collect_fixtures(dir, &mut results);
    results.sort();
    results
}

fn collect_fixtures(dir: &Path, results: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip `portable/` and `variant/` — different schema, their own
                // runners (`tests/portable.rs`, `tests/variant.rs`).
                if path
                    .file_name()
                    .map_or(false, |n| n == "portable" || n == "variant")
                {
                    continue;
                }
                collect_fixtures(&path, results);
            } else if path.extension().map_or(false, |e| e == "json") {
                results.push(path);
            }
        }
    }
}

fn load_fixture(path: &Path) -> TestCase {
    let content = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("Failed to read fixture {}: {e}", path.display()));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("Failed to parse fixture {}: {e}", path.display()))
}

fn should_skip(tc: &TestCase) -> Option<String> {
    // Check fixture-level skip list
    if let Some(ref skip) = tc.skip {
        if let Some(ref sdks) = skip.sdks {
            if sdks.iter().any(|s| s == "rust") {
                return skip
                    .reason
                    .clone()
                    .or_else(|| Some("skipped for rust".into()));
            }
        }
    }

    // Lifecycle fixtures require custom hook wiring (onCreated mutating state).
    // Also skipped for TS and Go runners.
    if tc.category == "lifecycle" {
        return Some("Lifecycle hooks require custom hook implementation in test runner".into());
    }

    // Per-fixture skips for known reconciliation strategy differences.
    // Conditional re-evaluation on state update uses a different dirty propagation strategy.
    //
    // NOTE: "foreach-dynamic-updates" and "keyed-list-add-remove" used to be
    // skipped here because ForEach rebuilt every child on a count change
    // (8 patches vs the expected 2). ForEach now goes through the same keyed
    // reconciliation as iterable elements, so both fixtures run.
    if tc.name.as_str() == "when-conditional-rendering" {
        return Some("Conditional dirty propagation: condition node re-evaluation pending".into());
    }

    None
}

// ---------------------------------------------------------------------------
// Patch matching (structural, ignoring IDs)
// ---------------------------------------------------------------------------

/// Compare two JSON values, treating numeric types as equal if their
/// f64 representations match (e.g., `100` == `100.0`).
fn json_values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(an), Value::Number(bn)) => an.as_f64() == bn.as_f64(),
        (Value::Object(am), Value::Object(bm)) => {
            am.len() == bm.len()
                && am
                    .iter()
                    .all(|(k, v)| bm.get(k).map_or(false, |bv| json_values_equal(v, bv)))
        }
        (Value::Array(aa), Value::Array(ba)) => {
            aa.len() == ba.len()
                && aa
                    .iter()
                    .zip(ba.iter())
                    .all(|(av, bv)| json_values_equal(av, bv))
        }
        _ => a == b,
    }
}

fn patch_to_json(patch: &Patch) -> Value {
    serde_json::to_value(patch).unwrap()
}

fn patch_type(patch: &Value) -> &str {
    patch["type"].as_str().unwrap_or("")
}

fn matches_expected_patch(actual: &Value, expected: &ExpectedPatch) -> bool {
    let actual_type = patch_type(actual);
    if actual_type != expected.patch_type {
        return false;
    }

    if let Some(ref et) = expected.element_type {
        if actual.get("elementType").and_then(|v| v.as_str()) != Some(et) {
            return false;
        }
    }

    if let Some(ref expected_props) = expected.props {
        let actual_props = actual.get("props");
        for (key, expected_val) in expected_props {
            let actual_val = actual_props.and_then(|p| p.get(key));
            match actual_val {
                Some(av) if json_values_equal(av, expected_val) => {}
                _ => return false,
            }
        }
    }

    if let Some(ref absent) = expected.absent_props {
        let actual_props = actual.get("props");
        for key in absent {
            if actual_props.and_then(|p| p.get(key)).is_some() {
                return false;
            }
        }
    }

    if let Some(ref name) = expected.name {
        if actual.get("name").and_then(|v| v.as_str()) != Some(name) {
            return false;
        }
    }

    if let Some(ref value) = expected.value {
        match actual.get("value") {
            Some(av) if json_values_equal(av, value) => {}
            _ => return false,
        }
    }

    if expected.value_is_null == Some(true) {
        // The key must be present AND carry explicit null — a missing key or
        // any non-null value (e.g. a stale label object) is a mismatch.
        match actual.get("value") {
            Some(Value::Null) => {}
            _ => return false,
        }
    }

    if let Some(transition) = expected.transition {
        let actual_flag = actual
            .get("transition")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if actual_flag != transition {
            return false;
        }
    }

    if let Some(ref spec) = expected.spec {
        // Exact object equality pins the complete normalized wire spec.
        match actual.get("spec") {
            Some(av) if json_values_equal(av, spec) => {}
            _ => return false,
        }
    }

    if let Some(ref semantics) = expected.semantics {
        // Exact object equality (json_values_equal requires equal key sets)
        // pins the complete semantics wire block, not a subset of it.
        match actual.get("semantics") {
            Some(av) if json_values_equal(av, semantics) => {}
            _ => return false,
        }
    }

    true
}

/// Index-by-index match — for fixtures whose contract IS the emission order
/// (e.g. flagged-root-first deferred removes), where the unordered
/// structural match below cannot distinguish orderings.
fn match_patches_sequence(actual_patches: &[Value], expected_patches: &[ExpectedPatch]) -> bool {
    actual_patches.len() == expected_patches.len()
        && actual_patches
            .iter()
            .zip(expected_patches)
            .all(|(actual, expected)| matches_expected_patch(actual, expected))
}

fn match_patches_structural(actual_patches: &[Value], expected_patches: &[ExpectedPatch]) -> bool {
    // For each expected patch, find a matching actual patch
    let mut used = vec![false; actual_patches.len()];

    for expected in expected_patches {
        let found = actual_patches
            .iter()
            .enumerate()
            .find(|(i, actual)| !used[*i] && matches_expected_patch(actual, expected));

        match found {
            Some((i, _)) => used[i] = true,
            None => return false,
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Action handlers (hardcoded, matching TS/Go runners)
// ---------------------------------------------------------------------------

fn get_action_handler(name: &str) -> Option<Box<dyn Fn(Option<&Value>, &mut Value) + Send + Sync>> {
    match name {
        "handleClick" => Some(Box::new(|_payload, state| {
            if let Value::Object(map) = state {
                map.insert("clicked".into(), Value::Bool(true));
            }
        })),
        "selectItem" => Some(Box::new(|payload, state| {
            if let Value::Object(map) = state {
                let id = payload
                    .and_then(|p| p.get("id"))
                    .cloned()
                    .unwrap_or(Value::Null);
                map.insert("selectedId".into(), id);
            }
        })),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/// Parse the source string into an IRNode.
/// Uses `parse_document` when imports are present, `parse_component` otherwise.
fn parse_source_to_ir(name: &str, source: &str) -> IRNode {
    if source.contains("import ") {
        // Document with imports — use parse_document, take first component
        let doc = hypen_parser::parse_document(source)
            .unwrap_or_else(|e| panic!("[{name}] Document parse error: {e:?}"));
        let component = doc
            .components
            .first()
            .unwrap_or_else(|| panic!("[{name}] Document has no components"));
        hypen_engine::ast_to_ir_node(component)
    } else {
        let ast = hypen_parser::parse_component(source)
            .unwrap_or_else(|e| panic!("[{name}] Parse error: {e:?}"));
        hypen_engine::ast_to_ir_node(&ast)
    }
}

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

fn run_fixture(tc: &TestCase) {
    // Set up engine
    let mut engine = Engine::new();
    let mut current_state = tc
        .input
        .initial_state
        .clone()
        .unwrap_or(Value::Object(Default::default()));

    // Set up module
    if let Some(ref module_cfg) = tc.input.module {
        let module = Module::new(&module_cfg.name)
            .with_actions(module_cfg.actions.clone().unwrap_or_default())
            .with_state_keys(module_cfg.state_keys.clone().unwrap_or_default());

        let engine_module = ModuleInstance::new(module, current_state.clone());
        engine.set_module(engine_module);
    }

    // Collect patches via callback. The raw stream carries template-shaped
    // list rows as RegisterTemplate/Instantiate; fixtures assert the plain
    // Create+Insert wire, so lower each batch through a session-lifetime
    // expander before serializing.
    let collected_patches: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let patches_ref = collected_patches.clone();
    let expander = Mutex::new(TemplateExpander::new());
    engine.set_render_callback(move |patches| {
        let expanded = expander.lock().unwrap().expand(patches.to_vec());
        let jsons: Vec<Value> = expanded.iter().map(patch_to_json).collect();
        patches_ref.lock().unwrap().extend(jsons);
    });

    // Register action handlers
    let state_cell: Arc<Mutex<Value>> = Arc::new(Mutex::new(current_state.clone()));

    if let Some(ref module_cfg) = tc.input.module {
        for action_name in module_cfg.actions.as_deref().unwrap_or(&[]) {
            if let Some(handler) = get_action_handler(action_name) {
                let state_ref = state_cell.clone();
                engine.on_action(action_name, move |action| {
                    let mut state = state_ref.lock().unwrap();
                    handler(action.payload.as_ref(), &mut state);
                });
            }
        }
    }

    // Single-step test (expected at top level, no steps)
    if let Some(ref expected) = tc.expected {
        if tc.steps.is_none() {
            let ir_node = parse_source_to_ir(&tc.name, &tc.input.source);
            engine.render_ir_node(&ir_node);

            let patches = collected_patches.lock().unwrap();
            assert_expected(
                &tc.name,
                "single",
                &patches,
                expected.patch_count,
                expected.patch_types.as_deref(),
                expected.patches.as_deref(),
                expected.strict_patch_order.unwrap_or(false),
                None,
                None,
            );
            return;
        }
    }

    // Multi-step test
    if let Some(ref steps) = tc.steps {
        for (i, step) in steps.iter().enumerate() {
            let default_label = format!("step {i}");
            let step_label = step.description.as_deref().unwrap_or(&default_label);

            // Clear patches for this step
            collected_patches.lock().unwrap().clear();

            match step.action.as_str() {
                "initialRender" => {
                    let ir_node = parse_source_to_ir(&tc.name, &tc.input.source);
                    engine.render_ir_node(&ir_node);
                }
                "renderSource" => {
                    // Re-render with replacement source — reconciled against
                    // the existing tree, exercising subtree replacement /
                    // teardown paths.
                    let source = step.source.as_deref().unwrap_or_else(|| {
                        panic!("[{}] renderSource step needs `source`", tc.name)
                    });
                    let ir_node = parse_source_to_ir(&tc.name, source);
                    engine.render_ir_node(&ir_node);
                }
                "updateState" => {
                    if let Some(ref change) = step.state_change {
                        // Update our tracked state
                        if let Value::Object(ref new_vals) = change.new_values {
                            for (key, val) in new_vals {
                                set_nested_value(&mut current_state, key, val.clone());
                            }
                        }
                        *state_cell.lock().unwrap() = current_state.clone();

                        // Notify engine, forwarding the step's optional
                        // batch-animation context (Option D).
                        engine.update_state_with_animation(
                            None,
                            change.new_values.clone(),
                            step.animation.clone(),
                        );
                    }
                }
                "dispatchAction" => {
                    if let Some(ref action) = step.dispatch_action {
                        let engine_action = hypen_engine::dispatch::Action {
                            name: action.name.clone(),
                            payload: action.payload.clone(),
                            sender: None,
                        };
                        let _ = engine.dispatch_action(engine_action);

                        // After action, sync state back and update engine,
                        // stamping the update with the step's optional
                        // batch-animation context (Option D).
                        let handler_state = state_cell.lock().unwrap().clone();
                        if handler_state != current_state {
                            current_state = handler_state;
                            engine.update_state_with_animation(
                                None,
                                current_state.clone(),
                                step.animation.clone(),
                            );
                        }
                    }
                }
                other => {
                    panic!("[{}] Unknown step action: {other}", tc.name);
                }
            }

            let patches = collected_patches.lock().unwrap();
            assert_expected(
                &tc.name,
                step_label,
                &patches,
                step.expected_patch_count,
                step.expected_patch_types.as_deref(),
                step.expected_patches.as_deref(),
                step.strict_patch_order.unwrap_or(false),
                step.forbidden_patch_types.as_deref(),
                step.expected_state.as_ref().map(|s| (&current_state, s)),
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn assert_expected(
    test_name: &str,
    step: &str,
    patches: &[Value],
    patch_count: Option<usize>,
    patch_types: Option<&[String]>,
    expected_patches: Option<&[ExpectedPatch]>,
    strict_patch_order: bool,
    forbidden_types: Option<&[String]>,
    state_check: Option<(&Value, &Value)>,
) {
    if let Some(count) = patch_count {
        assert_eq!(
            patches.len(),
            count,
            "[{test_name}] {step}: expected {count} patches, got {}.\nPatches: {:#?}",
            patches.len(),
            patches
        );
    }

    if let Some(types) = patch_types {
        let actual_types: Vec<&str> = patches.iter().map(|p| patch_type(p)).collect();
        let expected_types: Vec<&str> = types.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            actual_types, expected_types,
            "[{test_name}] {step}: patch types mismatch"
        );
    }

    if let Some(expected) = expected_patches {
        let matched = if strict_patch_order {
            match_patches_sequence(patches, expected)
        } else {
            match_patches_structural(patches, expected)
        };
        assert!(
            matched,
            "[{test_name}] {step}: patch {} mismatch.\nActual:   {:#?}\nExpected: {:#?}",
            if strict_patch_order {
                "sequence"
            } else {
                "structure"
            },
            patches,
            expected
        );
    }

    if let Some(forbidden) = forbidden_types {
        let actual_types: Vec<&str> = patches.iter().map(|p| patch_type(p)).collect();
        for ft in forbidden {
            assert!(
                !actual_types.contains(&ft.as_str()),
                "[{test_name}] {step}: forbidden patch type '{ft}' found in: {actual_types:?}"
            );
        }
    }

    if let Some((actual_state, expected_state)) = state_check {
        if let Value::Object(expected_map) = expected_state {
            for (key, expected_val) in expected_map {
                let actual_val = actual_state.get(key);
                assert_eq!(
                    actual_val,
                    Some(expected_val),
                    "[{test_name}] {step}: state.{key} mismatch. got {actual_val:?}, expected {expected_val:?}"
                );
            }
        }
    }
}

/// Set a value at a dot-separated path in a JSON value.
fn set_nested_value(target: &mut Value, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() {
        return;
    }
    if parts.len() == 1 {
        if let Value::Object(map) = target {
            map.insert(parts[0].to_string(), value);
        }
        return;
    }

    let mut current = target;
    for part in &parts[..parts.len() - 1] {
        if let Ok(idx) = part.parse::<usize>() {
            if let Value::Array(arr) = current {
                while arr.len() <= idx {
                    arr.push(Value::Null);
                }
                current = &mut arr[idx];
                continue;
            }
        }
        if !current.is_object() {
            *current = Value::Object(Default::default());
        }
        if let Value::Object(map) = current {
            if !map.contains_key(*part) {
                map.insert(part.to_string(), Value::Object(Default::default()));
            }
            current = map.get_mut(*part).unwrap();
        }
    }

    let final_key = parts[parts.len() - 1];
    if let Ok(idx) = final_key.parse::<usize>() {
        if let Value::Array(arr) = current {
            while arr.len() <= idx {
                arr.push(Value::Null);
            }
            arr[idx] = value;
            return;
        }
    }
    if let Value::Object(map) = current {
        map.insert(final_key.to_string(), value);
    }
}

// ---------------------------------------------------------------------------
// Test entry point: discover and run all fixtures
// ---------------------------------------------------------------------------

#[test]
fn test_engine_compatibility() {
    let dir = fixtures_dir();
    let fixtures = find_fixtures(&dir);

    assert!(
        !fixtures.is_empty(),
        "No fixtures found in {}",
        dir.display()
    );

    let mut passed = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();

    for fixture_path in &fixtures {
        let tc = load_fixture(fixture_path);
        let rel_path = fixture_path
            .strip_prefix(&dir)
            .unwrap_or(fixture_path)
            .display();

        if let Some(reason) = should_skip(&tc) {
            eprintln!("  SKIP [{rel_path}] {} — {reason}", tc.name);
            skipped += 1;
            continue;
        }

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_fixture(&tc);
        }));

        match result {
            Ok(()) => {
                eprintln!("  PASS [{rel_path}] {}", tc.name);
                passed += 1;
            }
            Err(e) => {
                let msg = if let Some(s) = e.downcast_ref::<String>() {
                    s.clone()
                } else if let Some(s) = e.downcast_ref::<&str>() {
                    s.to_string()
                } else {
                    "unknown panic".to_string()
                };
                eprintln!("  FAIL [{rel_path}] {} — {msg}", tc.name);
                failed.push(format!("[{rel_path}] {}: {msg}", tc.name));
            }
        }
    }

    eprintln!(
        "\nCompatibility: {} passed, {} skipped, {} failed (of {} total)",
        passed,
        skipped,
        failed.len(),
        fixtures.len()
    );

    if !failed.is_empty() {
        panic!(
            "{} fixture(s) failed:\n  {}",
            failed.len(),
            failed.join("\n  ")
        );
    }
}
