//! Shared device-protocol conformance corpus (RFC 001) — Rust reference run.
//!
//! Every SDK consumes the same files under
//! `engine-compatibility-tests/fixtures/device/conformance/`:
//!
//! - `messages.json`: envelope-level valid/invalid device messages, given as
//!   a JSON value (`message`) or as exact text (`raw`, `rawHex` for bytes a
//!   JSON string cannot carry, `rawRepeat` for the 1 MiB size limit). Valid
//!   ones decode strictly, round-trip, and satisfy `envelope-v1.schema.json`;
//!   invalid ones are rejected by the decoder and (unless `beyondSchema`, or
//!   given as text) by the schema too. The `handshake` section holds
//!   `hello.device` / `sessionAck.device` / snapshot cases.
//! - `payloads.json`: per-revision params/result/event verdicts, checked
//!   against `validate_payload` and the capability schema definitions.
//! - `selection.json`: table-driven `select_device_ack` cases.
//!
//! Also pins `registry-v1.json` to `registry()` so this runs without the
//! `schema-export` feature (the byte-exact drift gate needs the feature), and
//! runs a small deterministic differential fuzz of the strict decoders
//! against the exported schemas.

use hypen_engine::serialize::device::payloads::Permission;
use hypen_engine::serialize::device::{
    registry, select_device_ack, validate_payload, CapabilitiesEvent, CapabilityOffer, DeviceAck,
    DeviceHello, DeviceMessage, PayloadKind, DEVICE_PROTOCOL_VERSION,
};
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine-compatibility-tests")
}

/// Fixture JSON with duplicate keys rejected (a duplicate is a fixture error).
struct FixtureValue(Value);

impl<'de> Deserialize<'de> for FixtureValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = FixtureValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_bool<E>(self, v: bool) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::from(v)))
            }
            fn visit_u64<E>(self, v: u64) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::from(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<FixtureValue, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| FixtureValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite"))
            }
            fn visit_str<E>(self, v: &str) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::String(v.into())))
            }
            fn visit_unit<E>(self) -> Result<FixtureValue, E> {
                Ok(FixtureValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<FixtureValue, A::Error> {
                let mut out = Vec::new();
                while let Some(FixtureValue(v)) = s.next_element()? {
                    out.push(v);
                }
                Ok(FixtureValue(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<FixtureValue, A::Error> {
                let mut out = Map::new();
                while let Some(k) = m.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom(format!("duplicate key `{k}`")));
                    }
                    let FixtureValue(v) = m.next_value()?;
                    out.insert(k, v);
                }
                Ok(FixtureValue(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}

fn load(path: &Path) -> Value {
    let raw = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str::<FixtureValue>(&raw)
        .map(|FixtureValue(v)| v)
        .unwrap_or_else(|e| panic!("{}: invalid fixture JSON: {e}", path.display()))
}

fn corpus(file: &str) -> Value {
    load(&base().join("fixtures/device/conformance").join(file))
}

fn schema(file: &str) -> Value {
    load(&base().join("schema/device").join(file))
}

fn def_validator(doc: &Value, def: &str) -> jsonschema::Validator {
    let mut schema = doc.clone();
    let obj = schema.as_object_mut().unwrap();
    obj.remove("oneOf");
    obj.remove("anyOf");
    obj.insert("$ref".into(), Value::String(format!("#/$defs/{def}")));
    jsonschema::validator_for(&schema).expect("schema compiles")
}

fn unique_names(cases: &[Value]) {
    let mut seen = HashSet::new();
    for c in cases {
        let name = c["name"].as_str().expect("case name");
        assert!(seen.insert(name.to_string()), "duplicate case name {name}");
    }
}

fn hex_decode(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd-length hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The exact bytes a text case stands for, or `None` for a `message` case.
fn case_bytes(case: &Value) -> Option<Vec<u8>> {
    let forms = ["message", "raw", "rawHex", "rawRepeat", "value"]
        .iter()
        .filter(|k| case.get(**k).is_some())
        .count();
    assert_eq!(forms, 1, "{}: exactly one case form", case["name"]);
    if let Some(raw) = case.get("raw") {
        return Some(raw.as_str().expect("raw is text").as_bytes().to_vec());
    }
    if let Some(hex) = case.get("rawHex") {
        return Some(hex_decode(hex.as_str().expect("rawHex")));
    }
    if let Some(rep) = case.get("rawRepeat") {
        let count = usize::try_from(rep["count"].as_u64().unwrap()).unwrap();
        let text = format!(
            "{}{}{}",
            rep["prefix"].as_str().unwrap(),
            rep["repeat"].as_str().unwrap().repeat(count),
            rep["suffix"].as_str().unwrap()
        );
        return Some(text.into_bytes());
    }
    None
}

#[test]
fn messages_corpus() {
    let doc = corpus("messages.json");
    let envelope = jsonschema::validator_for(&schema("envelope-v1.schema.json")).unwrap();
    let valid = doc["valid"].as_array().unwrap();
    let invalid = doc["invalid"].as_array().unwrap();
    unique_names(&valid.iter().chain(invalid).cloned().collect::<Vec<_>>());
    assert!(valid.len() >= 56 && invalid.len() >= 199);

    for case in valid {
        let name = case["name"].as_str().unwrap();
        if let Some(bytes) = case_bytes(case) {
            let msg = DeviceMessage::decode_bytes(&bytes)
                .unwrap_or_else(|e| panic!("{name}: valid text rejected: {e}"));
            let expected: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                serde_json::to_value(&msg).unwrap(),
                expected,
                "{name}: round-trip"
            );
            continue;
        }
        let message = &case["message"];
        let text = serde_json::to_string(message).unwrap();
        let msg = DeviceMessage::decode(&text)
            .unwrap_or_else(|e| panic!("{name}: valid message rejected: {e}"));
        assert_eq!(
            &serde_json::to_value(&msg).unwrap(),
            message,
            "{name}: round-trip"
        );
        assert!(
            envelope.is_valid(message),
            "{name}: envelope schema rejects a valid case"
        );
    }

    let mut text_cases = 0;
    for case in invalid {
        let name = case["name"].as_str().unwrap();
        assert!(case["reason"].is_string(), "{name}: reason missing");
        if let Some(bytes) = case_bytes(case) {
            assert!(
                DeviceMessage::decode_bytes(&bytes).is_err(),
                "{name}: text case accepted"
            );
            if let Ok(text) = std::str::from_utf8(&bytes) {
                assert!(DeviceMessage::decode(text).is_err(), "{name}");
            }
            text_cases += 1;
            continue;
        }
        let message = &case["message"];
        let text = serde_json::to_string(message).unwrap();
        assert!(
            DeviceMessage::decode(&text).is_err(),
            "{name}: invalid case accepted"
        );
        let beyond = case
            .get("beyondSchema")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert_eq!(
            envelope.is_valid(message),
            beyond,
            "{name}: schema verdict must be rejection unless beyondSchema"
        );
    }
    assert!(text_cases >= 80, "JSON-limit text cases missing");
}

#[test]
fn handshake_corpus() {
    let doc = corpus("messages.json");
    let cases = doc["handshake"].as_array().expect("handshake section");
    unique_names(cases);
    assert!(cases.len() >= 25);
    let hs = schema("handshake-v1.schema.json");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let expect = case["valid"].as_bool().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let (got, def) = match (case_bytes(case), kind) {
            (Some(bytes), k) => {
                let text = std::str::from_utf8(&bytes).unwrap();
                let ok = match k {
                    "hello" => DeviceHello::decode(text).is_ok(),
                    "ack" => DeviceAck::decode(text).is_ok(),
                    "capabilitiesEvent" => CapabilitiesEvent::decode(text).is_ok(),
                    other => panic!("{name}: kind {other}"),
                };
                (ok, None)
            }
            (None, k) => {
                let v = &case["value"];
                let (ok, def) = match k {
                    "hello" => (DeviceHello::from_value(v).is_ok(), "deviceHello"),
                    "ack" => (DeviceAck::from_value(v).is_ok(), "deviceAck"),
                    "capabilitiesEvent" => (
                        CapabilitiesEvent::from_value(v).is_ok(),
                        "capabilitiesEvent",
                    ),
                    other => panic!("{name}: kind {other}"),
                };
                (ok, Some(def))
            }
        };
        assert_eq!(got, expect, "{name}: Rust verdict");
        if let Some(def) = def {
            let beyond = case
                .get("beyondSchema")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let schema_ok = def_validator(&hs, def).is_valid(&case["value"]);
            assert_eq!(schema_ok, expect || beyond, "{name}: schema verdict");
        }
    }
}

#[test]
fn payloads_corpus() {
    let doc = corpus("payloads.json");
    let cases = doc["cases"].as_array().unwrap();
    unique_names(cases);
    assert!(cases.len() >= 270);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let capability = case["capability"].as_str().unwrap();
        let version = u32::try_from(case["version"].as_u64().unwrap()).unwrap();
        let (kind, def) = match case["kind"].as_str().unwrap() {
            "params" => (PayloadKind::Params, "params"),
            "result" => (PayloadKind::Result, "result"),
            "event" => (PayloadKind::Event, "event"),
            other => panic!("{name}: kind {other}"),
        };
        let value = &case["value"];
        let expect = case["valid"].as_bool().unwrap();
        let got = validate_payload(capability, version, kind, value);
        assert_eq!(got.is_ok(), expect, "{name}: Rust verdict {got:?}");

        let path = base()
            .join("schema/device")
            .join(format!("{capability}-v{version}.schema.json"));
        if path.exists() {
            let beyond = case
                .get("beyondSchema")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let schema_ok = def_validator(&load(&path), def).is_valid(value);
            assert_eq!(schema_ok, expect || beyond, "{name}: schema verdict");
        } else {
            assert!(
                !expect,
                "{name}: a valid case needs an exported revision schema"
            );
        }
    }
}

#[test]
fn selection_corpus() {
    let doc = corpus("selection.json");
    let cases = doc["cases"].as_array().unwrap();
    unique_names(cases);
    assert!(cases.len() >= 28);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        // Structural decode; select_device_ack validates the hello itself
        // (decision D7), and a strictly invalid hello must yield `null`.
        let hello: DeviceHello = serde_json::from_value(case["hello"].clone())
            .unwrap_or_else(|e| panic!("{name}: hello: {e}"));
        let strict_ok = DeviceHello::from_value(&case["hello"]).is_ok();
        let server_caps: Vec<CapabilityOffer> =
            serde_json::from_value(case["serverCapabilities"].clone()).unwrap();
        let server_versions: Vec<u32> = match case.get("serverProtocolVersions") {
            Some(v) => serde_json::from_value(v.clone()).unwrap(),
            None => vec![DEVICE_PROTOCOL_VERSION],
        };
        let binary = case["serverBinary"].as_bool().unwrap();
        let got = select_device_ack(&hello, &server_versions, &server_caps, binary);
        let expect = match &case["expect"] {
            Value::Null => None,
            v => Some(DeviceAck::from_value(v).unwrap_or_else(|e| panic!("{name}: expect: {e}"))),
        };
        assert_eq!(got, expect, "{name}");
        if !strict_ok {
            assert!(
                got.is_none(),
                "{name}: an invalid hello must disable device access"
            );
        }
        if let Some(ack) = &got {
            ack.validate()
                .unwrap_or_else(|e| panic!("{name}: ack invalid: {e}"));
        }
    }
}

/// Every registry revision has payload coverage: a valid and an invalid
/// `params` case, and a valid and an invalid `result` case; the permission revisions have
/// a valid case for every `Permission` name (and nothing else is valid).
#[test]
fn payload_corpus_covers_every_registry_revision() {
    let doc = corpus("payloads.json");
    let cases = doc["cases"].as_array().unwrap();
    let has = |cap: &str, version: u32, kind: &str, valid: bool| {
        cases.iter().any(|c| {
            c["capability"] == cap
                && c["version"] == version
                && c["kind"] == kind
                && c["valid"] == valid
        })
    };
    for decl in registry() {
        for rev in decl.revisions {
            let (cap, v) = (decl.name, rev.version);
            assert!(
                has(cap, v, "params", true),
                "{cap}@{v}: no valid params case"
            );
            assert!(
                has(cap, v, "params", false),
                "{cap}@{v}: no invalid params case"
            );
            assert!(
                has(cap, v, "result", true),
                "{cap}@{v}: no valid result case"
            );
            assert!(
                has(cap, v, "result", false),
                "{cap}@{v}: no invalid result case"
            );
        }
    }
    for cap in ["permission.query", "permission.request"] {
        let valid: HashSet<&str> = cases
            .iter()
            .filter(|c| c["capability"] == cap && c["kind"] == "params" && c["valid"] == true)
            .map(|c| c["value"]["permission"].as_str().unwrap())
            .collect();
        let all: HashSet<&str> = Permission::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(valid, all, "{cap}: valid permission names");
    }
}

#[test]
fn registry_document_matches_registry() {
    let on_disk = schema("registry-v1.json");
    let expected = serde_json::json!({
        "protocolVersion": DEVICE_PROTOCOL_VERSION,
        "capabilities": registry(),
    });
    assert_eq!(on_disk, expected, "registry-v1.json is stale");
}

// ---------------------------------------------------------------------------
// Differential fuzz: strict decoders vs. exported schemas
// ---------------------------------------------------------------------------

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn boundary(rng: &mut Rng) -> Value {
    const MIB: u64 = 1024 * 1024;
    let pool: [Value; 22] = [
        json!(0),
        json!(1),
        json!(-1),
        json!(16),
        json!(17),
        json!(65535),
        json!(65536),
        json!(4294967295u64),
        json!(4294967296u64),
        json!(8 * MIB),
        json!(8 * MIB + 1),
        json!(64 * MIB),
        json!(64 * MIB + 1),
        json!(9007199254740991u64),
        json!(null),
        json!(true),
        json!(""),
        json!("\u{1F600}".repeat(129)),
        json!("x".repeat(513)),
        json!([]),
        json!({}),
        json!(["photo"]),
    ];
    pool[rng.below(pool.len())].clone()
}

/// One structural mutation somewhere in `v`.
fn mutate(v: &mut Value, rng: &mut Rng) {
    match v {
        Value::Object(map) if !map.is_empty() && rng.below(4) != 0 => {
            let keys: Vec<String> = map.keys().cloned().collect();
            let key = keys[rng.below(keys.len())].clone();
            match rng.below(6) {
                0 => {
                    map.remove(&key);
                }
                1 => {
                    let val = map.remove(&key).unwrap();
                    let mut k = key.clone();
                    k.replace_range(0..1, &k[0..1].to_uppercase());
                    map.insert(k, val);
                }
                2 => {
                    map.insert("extra".into(), boundary(rng));
                }
                3 => {
                    // Array-for-object / map-for-enum shapes.
                    let val = map.remove(&key).unwrap();
                    let wrapped = match val {
                        Value::Object(inner) => Value::Array(inner.into_values().collect()),
                        Value::String(s) => json!({ s: null }),
                        other => json!([other]),
                    };
                    map.insert(key, wrapped);
                }
                _ => mutate(map.get_mut(&key).unwrap(), rng),
            }
        }
        Value::Array(items) if !items.is_empty() && rng.below(4) != 0 => match rng.below(3) {
            0 => {
                let dup = items[rng.below(items.len())].clone();
                items.push(dup);
            }
            1 => {
                items.remove(rng.below(items.len()));
            }
            _ => {
                let i = rng.below(items.len());
                mutate(&mut items[i], rng);
            }
        },
        other => *other = boundary(rng),
    }
}

/// Mutated corpus envelopes and payloads: whenever the Rust decoder accepts,
/// the exported schema must accept too (the decoder may be stricter: JSON
/// limits and beyond-schema rules). Catches serde leniency such as
/// array-encoded structs and map-encoded enums.
#[test]
fn strict_decoders_never_accept_what_the_schemas_reject() {
    let envelope = jsonschema::validator_for(&schema("envelope-v1.schema.json")).unwrap();
    let messages = corpus("messages.json");
    let seeds: Vec<Value> = messages["valid"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c.get("message").cloned())
        .collect();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut accepted = 0;
    for i in 0..6000 {
        let mut v = seeds[i % seeds.len()].clone();
        for _ in 0..=rng.below(2) {
            mutate(&mut v, &mut rng);
        }
        let text = serde_json::to_string(&v).unwrap();
        if DeviceMessage::decode(&text).is_ok() {
            accepted += 1;
            assert!(
                envelope.is_valid(&v),
                "Rust accepts what envelope-v1 rejects: {text}"
            );
        }
    }
    assert!(accepted > 100, "fuzz produced too few accepted envelopes");

    let payloads = corpus("payloads.json");
    let cases: Vec<&Value> = payloads["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["valid"] == true)
        .collect();
    let mut validators = std::collections::HashMap::new();
    let mut accepted = 0;
    for i in 0..6000 {
        let case = cases[i % cases.len()];
        let cap = case["capability"].as_str().unwrap();
        let (kind, def) = match case["kind"].as_str().unwrap() {
            "params" => (PayloadKind::Params, "params"),
            "result" => (PayloadKind::Result, "result"),
            _ => (PayloadKind::Event, "event"),
        };
        let validator = validators
            .entry((cap.to_string(), def))
            .or_insert_with(|| def_validator(&schema(&format!("{cap}-v1.schema.json")), def));
        let mut v = case["value"].clone();
        for _ in 0..=rng.below(2) {
            mutate(&mut v, &mut rng);
        }
        if validate_payload(cap, 1, kind, &v).is_ok() {
            accepted += 1;
            assert!(
                validator.is_valid(&v),
                "Rust accepts a {cap} {def} its schema rejects: {v}"
            );
        }
    }
    assert!(accepted > 100, "fuzz produced too few accepted payloads");
}
