//! Cross-SDK compatibility runner for the engine's portable pure helpers.
//!
//! Loads every JSON fixture under
//! `engine-compatibility-tests/fixtures/portable/` and feeds it through
//! the engine's canonical implementations (`hypen_engine::diff_paths`,
//! `match_path`, `session_step`). Every host SDK runs the same fixtures
//! through its own bindings and must produce byte-equal output.
//!
//! Add a new fixture by dropping a JSON file under
//! `fixtures/portable/<category>/`; every runner picks it up
//! automatically on next run.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use hypen_engine::{
    build_url, decode_uri_component, diff_paths, encode_uri_component, match_path, parse_query,
    path_delete, path_get, path_has, path_set, session_step, SessionEvent, SessionState,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FnKind {
    DiffPaths,
    MatchPath,
    SessionStep,
    PathGet,
    PathHas,
    PathSet,
    PathDelete,
    EncodeUriComponent,
    DecodeUriComponent,
    ParseQuery,
    BuildUrl,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    #[allow(dead_code)]
    description: String,
    function: FnKind,
    input: Value,
    expected: Value,
}

fn fixtures_root() -> PathBuf {
    // tests/ is next to Cargo.toml in runners/rust/
    let runner_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    runner_dir
        .join("../..")
        .join("fixtures")
        .join("portable")
        .canonicalize()
        .expect("portable fixtures dir")
}

fn collect_fixtures(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root).expect("read portable fixtures root") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            for sub in fs::read_dir(&path).expect("read subdir") {
                let sub = sub.expect("sub entry").path();
                if sub.extension().and_then(|e| e.to_str()) == Some("json") {
                    out.push(sub);
                }
            }
        }
    }
    out.sort();
    out
}

fn sorted_object(value: &Value) -> Value {
    match value {
        Value::Object(m) => {
            let sorted: BTreeMap<_, _> = m.iter().map(|(k, v)| (k.clone(), sorted_object(v))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted_object).collect()),
        other => other.clone(),
    }
}

fn run_diff_paths(fixture: &Fixture) {
    let old = &fixture.input["old"];
    let new = &fixture.input["new"];
    let got: Vec<Value> = diff_paths(old, new)
        .into_iter()
        .map(|e| serde_json::json!({ "path": e.path, "value": e.new_value }))
        .collect();

    // Order-insensitive comparison: sort both by path.
    let mut got_sorted = got.clone();
    got_sorted.sort_by(|a, b| a["path"].as_str().unwrap().cmp(b["path"].as_str().unwrap()));
    let mut want = fixture.expected.as_array().expect("expected array").clone();
    want.sort_by(|a, b| a["path"].as_str().unwrap().cmp(b["path"].as_str().unwrap()));

    assert_eq!(
        got_sorted, want,
        "fixture '{}' diff_paths mismatch:\n  got:  {:?}\n  want: {:?}",
        fixture.name, got_sorted, want
    );
}

fn run_match_path(fixture: &Fixture) {
    let pattern = fixture.input["pattern"].as_str().unwrap();
    let path = fixture.input["path"].as_str().unwrap();
    let got = match match_path(pattern, path) {
        Some(m) => {
            let params: BTreeMap<String, String> = m.params.into_iter().collect();
            serde_json::json!({ "matched": true, "params": params })
        }
        None => serde_json::json!({ "matched": false, "params": {} }),
    };
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' match_path mismatch",
        fixture.name,
    );
}

fn run_path_get(fixture: &Fixture) {
    let value = &fixture.input["value"];
    let path = fixture.input["path"].as_str().unwrap();
    let got = path_get(value, path).unwrap_or(Value::Null);
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' path_get mismatch",
        fixture.name,
    );
}

fn run_path_has(fixture: &Fixture) {
    let value = &fixture.input["value"];
    let path = fixture.input["path"].as_str().unwrap();
    let got = serde_json::json!(path_has(value, path));
    assert_eq!(
        got, fixture.expected,
        "fixture '{}' path_has mismatch",
        fixture.name,
    );
}

fn run_path_set(fixture: &Fixture) {
    let mut value = fixture.input["value"].clone();
    let path = fixture.input["path"].as_str().unwrap();
    let new_value = fixture.input["new_value"].clone();
    path_set(&mut value, path, new_value);
    assert_eq!(
        sorted_object(&value),
        sorted_object(&fixture.expected),
        "fixture '{}' path_set mismatch",
        fixture.name,
    );
}

fn run_path_delete(fixture: &Fixture) {
    let mut value = fixture.input["value"].clone();
    let path = fixture.input["path"].as_str().unwrap();
    let removed = path_delete(&mut value, path);
    let got = serde_json::json!({ "json": value, "removed": removed });
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' path_delete mismatch",
        fixture.name,
    );
}

fn run_encode_uri_component(fixture: &Fixture) {
    let input = fixture.input.as_str().unwrap();
    let got = Value::String(encode_uri_component(input));
    assert_eq!(got, fixture.expected, "fixture '{}' encode mismatch", fixture.name);
}

fn run_decode_uri_component(fixture: &Fixture) {
    let input = fixture.input.as_str().unwrap();
    let got = Value::String(decode_uri_component(input));
    assert_eq!(got, fixture.expected, "fixture '{}' decode mismatch", fixture.name);
}

fn run_parse_query(fixture: &Fixture) {
    let input = fixture.input.as_str().unwrap();
    let (path, query) = parse_query(input);
    let got = serde_json::json!({ "path": path, "query": query });
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' parse_query mismatch",
        fixture.name,
    );
}

fn run_build_url(fixture: &Fixture) {
    let path = fixture.input["path"].as_str().unwrap();
    let query: std::collections::BTreeMap<String, String> =
        serde_json::from_value(fixture.input["query"].clone()).unwrap();
    let got = Value::String(build_url(path, &query));
    assert_eq!(got, fixture.expected, "fixture '{}' build_url mismatch", fixture.name);
}

fn run_session_step(fixture: &Fixture) {
    let state: SessionState = serde_json::from_value(fixture.input["state"].clone()).unwrap();
    let event: SessionEvent = serde_json::from_value(fixture.input["event"].clone()).unwrap();
    let effect = session_step(&state, &event);
    let got = serde_json::to_value(&effect).unwrap();
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' session_step mismatch",
        fixture.name,
    );
}

#[test]
fn portable_fixtures_match_engine_output() {
    let root = fixtures_root();
    let paths = collect_fixtures(&root);
    assert!(!paths.is_empty(), "no portable fixtures found at {:?}", root);

    for path in paths {
        let raw = fs::read_to_string(&path).expect("read fixture");
        let fixture: Fixture =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {:?}: {e}", path));

        match fixture.function {
            FnKind::DiffPaths => run_diff_paths(&fixture),
            FnKind::MatchPath => run_match_path(&fixture),
            FnKind::SessionStep => run_session_step(&fixture),
            FnKind::PathGet => run_path_get(&fixture),
            FnKind::PathHas => run_path_has(&fixture),
            FnKind::PathSet => run_path_set(&fixture),
            FnKind::PathDelete => run_path_delete(&fixture),
            FnKind::EncodeUriComponent => run_encode_uri_component(&fixture),
            FnKind::DecodeUriComponent => run_decode_uri_component(&fixture),
            FnKind::ParseQuery => run_parse_query(&fixture),
            FnKind::BuildUrl => run_build_url(&fixture),
        }
    }
}
