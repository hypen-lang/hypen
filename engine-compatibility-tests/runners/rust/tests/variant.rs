//! Cross-SDK compatibility runner for the renderer-side variant parser /
//! resolver (`hypen_engine::portable::variant`).
//!
//! Variant resolution is renderer-side: every renderer (web `variants.ts`,
//! desktop via this engine helper, Swift/Android `VariantSupport`) runs its own
//! parser/precedence. These fixtures are the single language-agnostic contract
//! they must all satisfy, so the implementations can't drift. This runner pins
//! the Rust engine helper (which the desktop renderer calls directly); the
//! TypeScript runner pins `variants.ts` (DOM + Canvas) against the same files.
//!
//! Add a fixture by dropping JSON under `fixtures/variant/<category>/`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use hypen_engine::portable::{parse_prop_key, pick_variant_base};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FnKind {
    ParsePropKey,
    ResolveVariant,
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
    let runner_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    runner_dir
        .join("../..")
        .join("fixtures")
        .join("variant")
        .canonicalize()
        .expect("variant fixtures dir")
}

fn collect_fixtures(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root).expect("read variant fixtures root") {
        let path = entry.expect("dir entry").path();
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
            let sorted: BTreeMap<_, _> = m
                .iter()
                .map(|(k, v)| (k.clone(), sorted_object(v)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted_object).collect()),
        other => other.clone(),
    }
}

/// Reconstruct a key's variant-decorated base (base + `@bp` + `:state`, no arg),
/// mirroring the engine's private `decorated_base`, so resolve fixtures can use
/// any arg suffix rather than being pinned to `.0`.
fn decorated_of(key: &str) -> String {
    let p = parse_prop_key(key);
    let mut d = p.base;
    if let Some(bp) = p.breakpoint {
        d.push('@');
        d.push_str(&bp);
    }
    if let Some(st) = p.state {
        d.push(':');
        d.push_str(&st);
    }
    d
}

fn run_parse(fixture: &Fixture) {
    let key = fixture.input["key"].as_str().expect("input.key");
    let p = parse_prop_key(key);
    let got = json!({
        "base": p.base,
        "breakpoint": p.breakpoint,
        "state": p.state,
        "arg": p.arg,
    });
    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' parse_prop_key mismatch",
        fixture.name,
    );
}

fn run_resolve(fixture: &Fixture) {
    let base = fixture.input["base"].as_str().expect("input.base");
    let props = fixture.input["props"].as_object().expect("input.props");
    let width = fixture.input["width"].as_f64().expect("input.width") as f32;
    let states: Vec<&str> = fixture.input["activeStates"]
        .as_array()
        .expect("input.activeStates")
        .iter()
        .map(|v| v.as_str().expect("state string"))
        .collect();

    let keys: Vec<&str> = props.keys().map(|s| s.as_str()).collect();

    // The resolver returns the winning variant-decorated base WITHOUT the arg
    // suffix. Find the prop key whose own decorated base equals it (independent
    // of the arg suffix, so this isn't restricted to `.0`) and read its value —
    // this mirrors the TS runner reading resolveVariantProps(...)[base]. `None`
    // (or no matching key) -> null.
    let got = match pick_variant_base(base, &keys, width, &states) {
        Some(decorated) => props
            .iter()
            .find(|(k, _)| decorated_of(k) == decorated)
            .map(|(_, v)| v.clone())
            .unwrap_or(Value::Null),
        None => Value::Null,
    };

    assert_eq!(
        sorted_object(&got),
        sorted_object(&fixture.expected),
        "fixture '{}' resolve_variant mismatch",
        fixture.name,
    );
}

#[test]
fn variant_fixtures_match_engine_output() {
    let root = fixtures_root();
    let paths = collect_fixtures(&root);
    assert!(!paths.is_empty(), "no variant fixtures found at {:?}", root);

    for path in paths {
        let raw = fs::read_to_string(&path).expect("read fixture");
        let fixture: Fixture =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {:?}: {e}", path));
        match fixture.function {
            FnKind::ParsePropKey => run_parse(&fixture),
            FnKind::ResolveVariant => run_resolve(&fixture),
        }
    }
}
