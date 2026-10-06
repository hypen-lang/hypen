//! Hand-rolled JSON Schema export for the Device Capability Protocol.
//!
//! Emits closed (`additionalProperties: false`) draft 2020-12 schemas with
//! stable revisioned `$id`s, matching the house style of the hand-authored
//! schemas in `engine-compatibility-tests/schema/`. Deliberately not
//! `schemars`: the output style would clash, CI would pin to a schemars
//! version, and the declarations here are few enough to describe directly.
//!
//! The capability documents are driven by [`registry()`]: every declared
//! revision gets a document whose per-revision bounds (item bytes, item and
//! channel counts) come from its registry entry, and a revision without a
//! payload declaration here panics the export. Envelope-level bounds
//! (`timeoutMs`, `initialCredit`, `grant`) are the largest registry maxima.
//! The registry itself is exported as `registry-v1.json`.
//!
//! Output is canonical: object keys are sorted explicitly (independent of
//! `serde_json/preserve_order` feature unification), and every `$defs` entry
//! is reachable from its document root.
//!
//! Keywords used: `type`, `properties`, `required`, `additionalProperties`,
//! `oneOf`, `anyOf` (only as a capability document's root: its `params` and
//! `result` may both be the closed empty object, so `oneOf` would reject a
//! valid `{}`), `not`, `$ref` (local `#/$defs/…` only), `const`, `enum`,
//! `minimum`/`maximum`, `minLength`/`maxLength` (Unicode code points),
//! `pattern`, `items`, `minItems`/`maxItems`, `uniqueItems`.
//!
//! Not expressible in these documents and enforced by every decoder: the
//! RFC 001 §2.1 JSON limits (1 MiB text, depth 32, integer tokens only within
//! ±(2^53 − 1), no raw control characters or lone surrogates, duplicate keys
//! rejected), canonical shapes (JSON Schema `type: integer` also matches
//! `1.0`), and the cross-member rules each description lists.
//!
//! Provisional per RFC 001 §6 Phase 0: these documents may change together
//! with the Rust declarations until the Phase 4 real-driver gate. Agreement
//! between the Rust decoder and these schemas is pinned by the shared
//! conformance corpus (`fixtures/device/conformance/`) and by the transcript
//! runner, which validates every message against these documents.

use super::payloads::{camera_content_types, Permission};
use super::{
    limits, registry, registry_max_initial_credit, registry_max_outstanding_credit,
    registry_max_timeout_ms, CapabilityRevision, DataPlane, DeviceErrorCode,
    BLUETOOTH_UUID_PATTERN, CORE_CAPABILITIES, DEVICE_PROTOCOL_VERSION, JSON_SAFE_MAX,
};
use serde_json::{json, Map, Value};

const SCHEMA_DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
const ID_BASE: &str = "https://hypen.space/schemas/device/";
const SHA256_PATTERN: &str = "^[0-9a-f]{64}$";
/// File name of the exported registry document.
pub const REGISTRY_FILE: &str = "registry-v1.json";

fn closed_object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn uint(max: u64) -> Value {
    json!({"type": "integer", "minimum": 0, "maximum": max})
}

fn uint_min(min: u64, max: u64) -> Value {
    json!({"type": "integer", "minimum": min, "maximum": max})
}

fn string(max_len: usize) -> Value {
    json!({"type": "string", "maxLength": max_len})
}

fn string_nonempty(max_len: usize) -> Value {
    json!({"type": "string", "minLength": 1, "maxLength": max_len})
}

fn sha256() -> Value {
    json!({"type": "string", "pattern": SHA256_PATTERN})
}

fn enum_str(values: &[&str]) -> Value {
    json!({"type": "string", "enum": values})
}

fn array_of(items: Value, max_items: usize) -> Value {
    json!({"type": "array", "items": items, "maxItems": max_items})
}

/// A set: no duplicate entries.
fn set_of(items: Value, min_items: usize, max_items: usize) -> Value {
    json!({
        "type": "array", "items": items,
        "minItems": min_items, "maxItems": max_items, "uniqueItems": true
    })
}

fn reference(def: &str) -> Value {
    json!({"$ref": format!("#/$defs/{def}")})
}

fn one_of_refs(defs: &[&str]) -> Value {
    if defs.len() == 1 {
        reference(defs[0])
    } else {
        json!({"oneOf": defs.iter().map(|d| reference(d)).collect::<Vec<_>>()})
    }
}

/// Recursively rebuild every object with sorted keys.
fn canonical(v: Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = Map::new();
            for (k, v) in entries {
                out.insert(k, canonical(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        other => other,
    }
}

fn document(file: &str, title: &str, description: &str, root: Value, defs: Value) -> Value {
    let mut doc = Map::new();
    doc.insert("$schema".into(), json!(SCHEMA_DIALECT));
    doc.insert("$id".into(), json!(format!("{ID_BASE}{file}")));
    doc.insert("title".into(), json!(title));
    doc.insert("description".into(), json!(description));
    for (k, v) in root.as_object().expect("root must be an object schema") {
        doc.insert(k.clone(), v.clone());
    }
    doc.insert("$defs".into(), defs);
    canonical(Value::Object(doc))
}

fn u32_id() -> Value {
    uint_min(1, u32::MAX as u64)
}

fn owner_def() -> Value {
    json!({
        "oneOf": [
            closed_object(
                json!({
                    "moduleInstanceId": string_nonempty(limits::MODULE_INSTANCE_ID_MAX),
                    "activationId": u32_id()
                }),
                &["moduleInstanceId", "activationId"]
            ),
            closed_object(
                json!({"moduleInstanceId": string_nonempty(limits::MODULE_INSTANCE_ID_MAX)}),
                &["moduleInstanceId"]
            ),
            closed_object(json!({"connection": {"const": true}}), &["connection"])
        ]
    })
}

fn control_def() -> Value {
    json!({
        "oneOf": [
            closed_object(
                json!({"grant": uint_min(1, registry_max_outstanding_credit())}),
                &["grant"]
            ),
            closed_object(json!({"cancel": {"const": true}}), &["cancel"]),
            closed_object(json!({"renewLease": u32_id()}), &["renewLease"]),
            closed_object(json!({"leaseAck": u32_id()}), &["leaseAck"]),
            closed_object(json!({"paused": {"type": "boolean"}}), &["paused"])
        ]
    })
}

fn error_def() -> Value {
    let codes: Vec<Value> = DeviceErrorCode::ALL
        .iter()
        .map(|c| serde_json::to_value(c).expect("error code serializes"))
        .collect();
    closed_object(
        json!({
            "code": {"type": "string", "enum": codes},
            "platformDetail": string(limits::PLATFORM_DETAIL_MAX)
        }),
        &["code"],
    )
}

/// Channels allocated within the revision's item count (§2.3).
fn channel(rev: &CapabilityRevision) -> Value {
    uint(u64::from(rev.max_items).saturating_sub(1))
}

/// The `contentType` a revision's blob items may carry: any bounded string,
/// or the closed media-type set of `camera.capture@1`.
fn blob_content_type(name: &str, version: u32) -> Value {
    match (name, version) {
        ("camera.capture", 1) => {
            let types: Vec<&str> = camera_content_types().collect();
            enum_str(&types)
        }
        _ => string(limits::CONTENT_TYPE_MAX),
    }
}

fn blob_item_def(rev: &CapabilityRevision, content_type: Value) -> Value {
    closed_object(
        json!({
            "channel": channel(rev),
            "contentType": content_type,
            "bytes": uint(rev.max_item_bytes),
            "sha256": sha256()
        }),
        &["channel", "contentType", "bytes", "sha256"],
    )
}

/// `bytes` is optional (RFC 001 §2.4): present = exact declaration, absent
/// = unknown length (live sources); limits are enforced as bytes arrive.
fn blob_start_def(rev: &CapabilityRevision, content_type: Value) -> Value {
    closed_object(
        json!({
            "kind": {"const": "blobStart"},
            "channel": channel(rev),
            "contentType": content_type,
            "bytes": uint(rev.max_item_bytes)
        }),
        &["kind", "channel", "contentType"],
    )
}

fn progress_def() -> Value {
    closed_object(
        json!({
            "kind": {"const": "progress"},
            "state": enum_str(&["pendingConsent", "running"])
        }),
        &["kind", "state"],
    )
}

fn capability_offer_def() -> Value {
    closed_object(
        json!({
            "name": string_nonempty(limits::CAPABILITY_NAME_MAX),
            "versions": set_of(u32_id(), 0, limits::OFFER_VERSIONS_MAX)
        }),
        &["name", "versions"],
    )
}

/// The three-message envelope (RFC 001 §2.1).
fn envelope_schema() -> Value {
    let request = closed_object(
        json!({
            "type": {"const": "deviceRequest"},
            "id": u32_id(),
            "capability": string_nonempty(limits::CAPABILITY_NAME_MAX),
            "version": u32_id(),
            "owner": reference("owner"),
            "lifetime": enum_str(&["activation", "background", "connection"]),
            "timeoutMs": uint_min(1, registry_max_timeout_ms()),
            "initialCredit": uint(registry_max_initial_credit()),
            "params": {"type": "object"}
        }),
        &[
            "type",
            "id",
            "capability",
            "version",
            "owner",
            "lifetime",
            "timeoutMs",
            "initialCredit",
            "params",
        ],
    );
    // Terminal XOR: exactly one of result / error.
    let response = json!({
        "type": "object",
        "properties": {
            "type": {"const": "deviceResponse"},
            "id": u32_id(),
            "result": {"type": "object"},
            "error": reference("error"),
            "simulated": {"const": true}
        },
        "required": ["type", "id"],
        "additionalProperties": false,
        "oneOf": [
            {"required": ["result"], "not": {"required": ["error"]}},
            {"required": ["error"], "not": {"required": ["result"]}}
        ]
    });
    // event XOR control.
    let event = json!({
        "type": "object",
        "properties": {
            "type": {"const": "deviceEvent"},
            "id": u32_id(),
            "event": {"type": "object"},
            "control": reference("control")
        },
        "required": ["type", "id"],
        "additionalProperties": false,
        "oneOf": [
            {"required": ["event"], "not": {"required": ["control"]}},
            {"required": ["control"], "not": {"required": ["event"]}}
        ]
    });

    document(
        "envelope-v1.schema.json",
        "Device Capability Protocol envelope (protocol version 1)",
        "The three device messages. Capability params/results/events are \
         validated separately against the selected capability revision schema. \
         Not expressible here and enforced by every decoder: the owner shape \
         must match the lifetime; the RFC 001 §2.1 JSON limits (at most \
         1048576 bytes of text, nesting depth at most 32 containers, integer \
         tokens only with magnitude at most 2^53-1 and no -0, valid UTF-8 \
         with no raw control characters or lone surrogate escapes, duplicate \
         keys rejected at any depth) apply to the whole message including \
         params/result/event; and re-encoding a decoded message must give \
         back the input (no array for an object, no map for an enum).",
        json!({"oneOf": [reference("deviceRequest"), reference("deviceResponse"), reference("deviceEvent")]}),
        json!({
            "deviceRequest": request,
            "deviceResponse": response,
            "deviceEvent": event,
            "owner": owner_def(),
            "control": control_def(),
            "error": error_def()
        }),
    )
}

/// `hello.device` / `sessionAck.device` / `core.capabilities` event (§2.2).
fn handshake_schema() -> Value {
    let hello = closed_object(
        json!({
            "protocolVersions": set_of(u32_id(), 0, limits::HELLO_PROTOCOL_VERSIONS_MAX),
            "binary": {"type": "boolean"},
            "capabilities": array_of(reference("capabilityOffer"), limits::CAPABILITIES_MAX)
        }),
        &["protocolVersions", "binary", "capabilities"],
    );
    let ack = closed_object(
        json!({
            "protocolVersion": u32_id(),
            "binary": {"type": "boolean"},
            "capabilities": array_of(
                closed_object(
                    json!({
                        "name": string_nonempty(limits::CAPABILITY_NAME_MAX),
                        "version": u32_id()
                    }),
                    &["name", "version"]
                ),
                limits::CAPABILITIES_MAX
            )
        }),
        &["protocolVersion", "binary", "capabilities"],
    );
    let capabilities_event = closed_object(
        json!({"capabilities": array_of(reference("capabilityOffer"), limits::CAPABILITIES_MAX)}),
        &["capabilities"],
    );

    document(
        "handshake-v1.schema.json",
        "Device handshake extension (protocol version 1)",
        "Bootstrap advertisement/selection shapes. Fixed: incompatible \
         bootstrap changes require a separate extension. Not expressible \
         here and enforced by every decoder: capability names are unique \
         within one advertisement or selection (compared by exact code \
         points), and the RFC 001 §2.1 JSON limits apply. A hello.device \
         failing this schema disables device access.",
        json!({"oneOf": [reference("deviceHello"), reference("deviceAck"), reference("capabilitiesEvent")]}),
        json!({
            "deviceHello": hello,
            "deviceAck": ack,
            "capabilitiesEvent": capabilities_event,
            "capabilityOffer": capability_offer_def()
        }),
    )
}

/// Per-revision payload declarations: `(params, result, stream events)`,
/// plus helper defs the payloads reference. `None` when the revision has no
/// declaration — which fails the export.
struct Payloads {
    params: Value,
    result: Value,
    /// Capability-specific stream events (besides `progress`/`blobStart`).
    events: Vec<(&'static str, Value)>,
    helpers: Vec<(&'static str, Value)>,
}

fn payloads(name: &str, rev: &CapabilityRevision) -> Option<Payloads> {
    let empty = || closed_object(json!({}), &[]);
    let permission = || {
        let names: Vec<&str> = Permission::ALL.iter().map(|p| p.as_str()).collect();
        closed_object(json!({"permission": enum_str(&names)}), &["permission"])
    };
    let blob_item = || blob_item_def(rev, blob_content_type(name, rev.version));
    let permission_result = || {
        closed_object(
            json!({"status": enum_str(&["granted", "denied", "prompt"])}),
            &["status"],
        )
    };
    let max_count = || uint_min(1, u64::from(rev.max_items));
    let p = match (name, rev.version) {
        (CORE_CAPABILITIES, 1) => Payloads {
            params: empty(),
            result: empty(),
            events: vec![(
                "capabilities",
                closed_object(
                    json!({"capabilities": array_of(reference("capabilityOffer"), limits::CAPABILITIES_MAX)}),
                    &["capabilities"],
                ),
            )],
            helpers: vec![("capabilityOffer", capability_offer_def())],
        },
        ("permission.query", 1) | ("permission.request", 1) => Payloads {
            params: permission(),
            result: permission_result(),
            events: vec![],
            helpers: vec![],
        },
        ("gallery.pick", 1) => Payloads {
            params: closed_object(
                json!({
                    "mediaTypes": set_of(enum_str(&["photo", "video"]), 1, 2),
                    "maxCount": max_count()
                }),
                &["mediaTypes", "maxCount"],
            ),
            result: closed_object(
                json!({"items": array_of(reference("blobItem"), usize::from(rev.max_items))}),
                &["items"],
            ),
            events: vec![],
            helpers: vec![("blobItem", blob_item())],
        },
        ("camera.capture", 1) => {
            let facing = enum_str(&["front", "back"]);
            Payloads {
                // Two closed shapes keyed by `mode`: `maxDurationMs` exists
                // only on video.
                params: json!({"oneOf": [
                    closed_object(
                        json!({"mode": {"const": "photo"}, "facing": facing}),
                        &["mode"]
                    ),
                    closed_object(
                        json!({
                            "mode": {"const": "video"},
                            "facing": facing,
                            "maxDurationMs": uint_min(1, limits::CAMERA_MAX_DURATION_MS)
                        }),
                        &["mode"]
                    )
                ]}),
                result: closed_object(
                    json!({"items": {
                        "type": "array", "items": reference("blobItem"),
                        "minItems": 1, "maxItems": 1
                    }}),
                    &["items"],
                ),
                events: vec![],
                helpers: vec![("blobItem", blob_item())],
            }
        }
        ("bluetooth.select", 1) => Payloads {
            params: closed_object(
                json!({
                    "services": set_of(
                        json!({"type": "string", "pattern": BLUETOOTH_UUID_PATTERN}),
                        1,
                        limits::BLUETOOTH_SERVICES_MAX
                    ),
                    "namePrefix": string_nonempty(limits::BLUETOOTH_NAME_PREFIX_MAX)
                }),
                &[],
            ),
            result: closed_object(
                json!({"device": closed_object(
                    json!({
                        "id": string_nonempty(limits::BLUETOOTH_ID_MAX),
                        "name": string(limits::BLUETOOTH_NAME_MAX)
                    }),
                    &["id"]
                )}),
                &["device"],
            ),
            events: vec![],
            helpers: vec![],
        },
        ("file.pick", 1) => Payloads {
            params: closed_object(
                json!({
                    "accept": array_of(string(limits::ACCEPT_ENTRY_MAX), limits::ACCEPT_MAX_ITEMS),
                    "maxCount": max_count()
                }),
                &["accept", "maxCount"],
            ),
            result: closed_object(
                json!({"items": array_of(
                    closed_object(
                        json!({
                            "channel": channel(rev),
                            "name": string(limits::FILE_NAME_MAX),
                            "contentType": string(limits::CONTENT_TYPE_MAX),
                            "bytes": uint(rev.max_item_bytes),
                            "sha256": sha256()
                        }),
                        &["channel", "name", "contentType", "bytes", "sha256"]
                    ),
                    usize::from(rev.max_items)
                )}),
                &["items"],
            ),
            events: vec![],
            helpers: vec![],
        },
        ("file.save", 1) => Payloads {
            params: closed_object(
                json!({
                    "channel": {"const": 0},
                    "name": string(limits::FILE_NAME_MAX),
                    "contentType": string(limits::CONTENT_TYPE_MAX),
                    "bytes": uint_min(1, rev.max_item_bytes),
                    "sha256": sha256()
                }),
                &["channel", "name", "contentType", "bytes", "sha256"],
            ),
            result: closed_object(
                json!({"bytesWritten": uint(rev.max_item_bytes)}),
                &["bytesWritten"],
            ),
            events: vec![],
            helpers: vec![],
        },
        ("bluetooth.scan", 1) => Payloads {
            params: empty(),
            result: empty(),
            events: vec![(
                "device",
                closed_object(
                    json!({"device": closed_object(
                        json!({
                            "id": string(limits::BLUETOOTH_ID_MAX),
                            "name": string(limits::BLUETOOTH_NAME_MAX),
                            "rssi": {"type": "integer", "minimum": i16::MIN, "maximum": i16::MAX}
                        }),
                        &["id", "rssi"]
                    )}),
                    &["device"],
                ),
            )],
            helpers: vec![],
        },
        ("mic.record", 1) => Payloads {
            params: closed_object(
                json!({
                    "sampleRate": uint_min(
                        u64::from(limits::MIC_SAMPLE_RATE_MIN),
                        u64::from(limits::MIC_SAMPLE_RATE_MAX)
                    ),
                    "format": enum_str(&["pcm16"]),
                    "maxDurationMs": uint_min(1, limits::MIC_MAX_DURATION_MS),
                    "channels": uint_min(1, u64::from(limits::MIC_CHANNELS_MAX))
                }),
                &["sampleRate", "format"],
            ),
            result: closed_object(
                json!({"durationMs": uint(JSON_SAFE_MAX), "item": reference("blobItem")}),
                &["durationMs", "item"],
            ),
            events: vec![],
            helpers: vec![("blobItem", blob_item())],
        },
        _ => return None,
    };
    Some(p)
}

fn capability_doc(name: &str, rev: &CapabilityRevision) -> (String, Value) {
    let version = rev.version;
    let p = payloads(name, rev).unwrap_or_else(|| {
        panic!("registry revision {name}@{version} has no payload schema declaration")
    });
    let file = format!("{name}-v{version}.schema.json");
    let mut defs = Map::new();
    defs.insert("params".into(), p.params);
    defs.insert("result".into(), p.result);

    // Event union: capability stream events, blobStart on upload planes, and
    // the optional progress event every revision allows.
    let mut event_refs: Vec<&str> = Vec::new();
    for (def, schema) in p.events {
        defs.insert(def.into(), schema);
        event_refs.push(def);
    }
    if rev.data == DataPlane::BinaryUpload {
        defs.insert(
            "blobStart".into(),
            blob_start_def(rev, blob_content_type(name, version)),
        );
        event_refs.push("blobStart");
    }
    defs.insert("progress".into(), progress_def());
    event_refs.push("progress");
    defs.insert("event".into(), one_of_refs(&event_refs));
    for (def, schema) in p.helpers {
        defs.insert(def.into(), schema);
    }

    let doc = document(
        &file,
        &format!("{name} capability, revision {version}"),
        "Provisional (RFC 001 §6): may change until the Phase 4 real-driver \
         gate; after stabilization an optional addition creates a new revision. \
         Bounds come from this revision's registry entry (registry-v1.json). \
         Validate a payload against #/$defs/params, #/$defs/result or \
         #/$defs/event; the document root only accepts a value matching any \
         of them.",
        json!({"anyOf": [reference("params"), reference("result"), reference("event")]}),
        Value::Object(defs),
    );
    (file, doc)
}

/// The capability registry as data: `{protocolVersion, capabilities:[{name,
/// revisions:[…]}]}` in registry order, enum values in their serde
/// (camelCase) wire spelling, keys sorted.
pub fn export_registry() -> Value {
    canonical(json!({
        "protocolVersion": DEVICE_PROTOCOL_VERSION,
        "capabilities": registry(),
    }))
}

/// Every exported document as `(file name, document)` pairs, sorted by file
/// name: the envelope and handshake schemas, one schema per registry
/// revision, and the registry document itself ([`REGISTRY_FILE`]).
pub fn export() -> Vec<(String, Value)> {
    let mut docs = vec![
        ("envelope-v1.schema.json".to_string(), envelope_schema()),
        ("handshake-v1.schema.json".to_string(), handshake_schema()),
        (REGISTRY_FILE.to_string(), export_registry()),
    ];
    for decl in registry() {
        for rev in decl.revisions {
            docs.push(capability_doc(decl.name, rev));
        }
    }
    docs.sort_by(|a, b| a.0.cmp(&b.0));
    docs
}
