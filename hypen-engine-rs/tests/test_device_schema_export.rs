//! Device Capability Protocol schema export — checked-in diff gate (RFC 001).
//!
//! Run with `cargo test --features schema-export` (CI runs it). The test
//! fails when the exported schemas or the exported registry differ from the
//! checked-in files under `engine-compatibility-tests/schema/device/`. To
//! regenerate after a deliberate declaration change:
//!
//! ```bash
//! HYPEN_WRITE_SCHEMAS=1 cargo test --features schema-export --test test_device_schema_export
//! ```
//!
//! An export-diff check alone does not prove the Rust decoder agrees with
//! the schemas — that agreement is pinned by the shared conformance corpus
//! (`test_device_conformance.rs`) and the transcript runner
//! (`test_device_transcripts.rs`), which validate against these documents.

#![cfg(feature = "schema-export")]

use hypen_engine::serialize::device::schema::{export, export_registry, REGISTRY_FILE};
use hypen_engine::serialize::device::{
    registry, validate_payload, PayloadKind, NO_PAYLOAD_DECLARATION,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::PathBuf;

fn schema_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine-compatibility-tests/schema/device")
}

fn pretty(doc: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(doc).unwrap())
}

#[test]
fn test_schema_export_matches_checked_in() {
    let dir = schema_dir();
    let docs = export();
    assert!(!docs.is_empty());

    if std::env::var_os("HYPEN_WRITE_SCHEMAS").is_some() {
        fs::create_dir_all(&dir).expect("create schema dir");
        for (file, doc) in &docs {
            fs::write(dir.join(file), pretty(doc)).expect("write schema");
        }
    }

    // Every exported document must match its checked-in file byte-for-byte.
    let mut expected_files = Vec::new();
    for (file, doc) in &docs {
        expected_files.push(file.clone());
        let path = dir.join(file);
        let on_disk = fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!(
                "{file} missing — regenerate with HYPEN_WRITE_SCHEMAS=1 \
                 cargo test --features schema-export"
            )
        });
        assert_eq!(
            on_disk,
            pretty(doc),
            "{file} is stale — regenerate with HYPEN_WRITE_SCHEMAS=1"
        );
    }

    // No orphaned files: every JSON document on disk is still exported.
    for entry in fs::read_dir(&dir).expect("schema dir must exist") {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            assert!(
                expected_files.contains(&name),
                "orphaned file {name}: no longer exported"
            );
        }
    }

    // Stable-$id sanity: every schema carries the revisioned id and dialect.
    for (file, doc) in docs.iter().filter(|(f, _)| f.ends_with(".schema.json")) {
        assert_eq!(
            doc["$id"],
            serde_json::json!(format!("https://hypen.space/schemas/device/{file}"))
        );
        assert_eq!(
            doc["$schema"],
            serde_json::json!("https://json-schema.org/draft/2020-12/schema")
        );
    }
}

/// The capability documents are exactly one per registry revision, and each
/// revision has typed Rust payload declarations too.
#[test]
fn export_is_driven_by_the_registry() {
    let exported: BTreeSet<String> = export()
        .into_iter()
        .map(|(f, _)| f)
        .filter(|f| {
            f.ends_with(".schema.json")
                && !f.starts_with("envelope-")
                && !f.starts_with("handshake-")
        })
        .collect();
    let mut declared = BTreeSet::new();
    for decl in registry() {
        for rev in decl.revisions {
            declared.insert(format!("{}-v{}.schema.json", decl.name, rev.version));
            // A registry revision without a Rust payload declaration would
            // report "no payload declaration", not a schema mismatch.
            let err = validate_payload(decl.name, rev.version, PayloadKind::Params, &Value::Null)
                .unwrap_err();
            assert_ne!(err, NO_PAYLOAD_DECLARATION, "{}", decl.name);
        }
    }
    assert_eq!(exported, declared);
}

fn collect_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "$ref" {
                    let r = v.as_str().expect("$ref is a string");
                    let def = r
                        .strip_prefix("#/$defs/")
                        .unwrap_or_else(|| panic!("non-local $ref {r}"));
                    out.push(def.to_string());
                } else {
                    collect_refs(v, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| collect_refs(i, out)),
        _ => {}
    }
}

/// Round-3 schema shapes other SDKs generate types from: the permission
/// enum, the mode-keyed camera params, the camera media-type set, the
/// canonical Bluetooth UUID pattern and the mic `channels` bound.
#[test]
fn round3_schema_shapes() {
    use hypen_engine::serialize::device::payloads::{camera_content_types, Permission};
    use hypen_engine::serialize::device::BLUETOOTH_UUID_PATTERN;
    let docs: std::collections::HashMap<String, Value> = export().into_iter().collect();
    let names: Vec<Value> = Permission::ALL
        .iter()
        .map(|p| Value::from(p.as_str()))
        .collect();
    for cap in ["permission.query", "permission.request"] {
        let doc = &docs[&format!("{cap}-v1.schema.json")];
        assert_eq!(
            doc["$defs"]["params"]["properties"]["permission"]["enum"],
            Value::Array(names.clone()),
            "{cap}"
        );
    }
    let cam = &docs["camera.capture-v1.schema.json"]["$defs"];
    let branches = cam["params"]["oneOf"].as_array().expect("mode-keyed oneOf");
    let modes: Vec<&Value> = branches
        .iter()
        .map(|b| &b["properties"]["mode"]["const"])
        .collect();
    assert_eq!(modes, [&Value::from("photo"), &Value::from("video")]);
    assert!(branches[0]["properties"].get("maxDurationMs").is_none());
    assert!(branches[1]["properties"].get("maxDurationMs").is_some());
    let types: Vec<Value> = camera_content_types().map(Value::from).collect();
    assert_eq!(
        cam["blobItem"]["properties"]["contentType"]["enum"],
        Value::Array(types.clone())
    );
    assert_eq!(
        cam["blobStart"]["properties"]["contentType"]["enum"],
        Value::Array(types)
    );
    assert_eq!(cam["result"]["properties"]["items"]["minItems"], 1);
    assert_eq!(cam["result"]["properties"]["items"]["maxItems"], 1);
    let bt = &docs["bluetooth.select-v1.schema.json"]["$defs"];
    assert_eq!(
        bt["params"]["properties"]["services"]["items"]["pattern"],
        BLUETOOTH_UUID_PATTERN
    );
    assert_eq!(bt["params"]["required"], serde_json::json!([]));
    let mic = &docs["mic.record-v1.schema.json"]["$defs"]["params"]["properties"]["channels"];
    assert_eq!(
        (mic["minimum"].as_u64(), mic["maximum"].as_u64()),
        (Some(1), Some(2))
    );
}

/// Every `$defs` entry is reachable from its document root (no orphans), and
/// every `$ref` resolves.
#[test]
fn exported_defs_are_reachable() {
    for (file, doc) in export().iter().filter(|(f, _)| f.ends_with(".schema.json")) {
        let defs = doc["$defs"].as_object().expect("$defs");
        let mut root = doc.clone();
        root.as_object_mut().unwrap().remove("$defs");
        let mut queue = Vec::new();
        collect_refs(&root, &mut queue);
        let mut seen = HashSet::new();
        while let Some(def) = queue.pop() {
            if seen.insert(def.clone()) {
                let node = defs
                    .get(&def)
                    .unwrap_or_else(|| panic!("{file}: dangling $ref {def}"));
                collect_refs(node, &mut queue);
            }
        }
        for def in defs.keys() {
            assert!(seen.contains(def), "{file}: orphan $defs entry {def}");
        }
    }
}

/// Keys are sorted at every depth, independent of serde_json's map feature.
#[test]
fn export_is_canonical() {
    fn check(v: &Value, file: &str) {
        match v {
            Value::Object(map) => {
                let keys: Vec<&String> = map.keys().collect();
                let mut sorted = keys.clone();
                sorted.sort();
                assert_eq!(keys, sorted, "{file}: unsorted keys");
                map.values().for_each(|v| check(v, file));
            }
            Value::Array(items) => items.iter().for_each(|v| check(v, file)),
            _ => {}
        }
    }
    for (file, doc) in export() {
        check(&doc, &file);
    }
    let reg = export_registry();
    assert_eq!(reg["protocolVersion"], 1);
    let names: Vec<&str> = reg["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    let order: Vec<&str> = registry().iter().map(|c| c.name).collect();
    assert_eq!(
        names, order,
        "{REGISTRY_FILE}: capabilities must keep registry order"
    );
}

/// A capability document's root accepts every valid payload of its revision
/// (review finding: a root `oneOf` rejected a valid `{}` that matches both
/// the empty `params` and the empty `result` of core.capabilities@1 and
/// bluetooth.scan@1; the root is `anyOf`).
#[test]
fn capability_document_roots_accept_every_valid_payload() {
    let docs: std::collections::HashMap<String, Value> = export().into_iter().collect();
    let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-compatibility-tests/fixtures/device/conformance/payloads.json");
    let corpus: Value = serde_json::from_str(&fs::read_to_string(corpus_path).unwrap()).unwrap();
    let mut checked = 0;
    for case in corpus["cases"].as_array().unwrap() {
        if case["valid"] != true {
            continue;
        }
        let file = format!(
            "{}-v{}.schema.json",
            case["capability"].as_str().unwrap(),
            case["version"]
        );
        let doc = &docs[&file];
        assert!(
            doc.get("anyOf").is_some() && doc.get("oneOf").is_none(),
            "{file}"
        );
        let root = jsonschema::validator_for(doc).unwrap();
        assert!(
            root.is_valid(&case["value"]),
            "{file} root rejects valid {}",
            case["name"]
        );
        checked += 1;
    }
    assert!(checked >= 95);
    for file in [
        "core.capabilities-v1.schema.json",
        "bluetooth.scan-v1.schema.json",
        "bluetooth.select-v1.schema.json",
    ] {
        let root = jsonschema::validator_for(&docs[file]).unwrap();
        assert!(root.is_valid(&serde_json::json!({})), "{file}: {{}}");
    }
}
