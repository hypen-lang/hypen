//! The shared device-protocol transcripts
//! (`engine-compatibility-tests/fixtures/device/transcripts/`), replayed
//! against the desktop [`DeviceHost`] acting as the **client** endpoint.
//!
//! This pins how the desktop reacts to everything a server may send (RFC 001
//! §2.1, decisions D3/D8) — the robustness half of the tester report
//! "malformed messages break … desktop rendering":
//!
//! - every server → client step is fed through the host's socket edge with
//!   its exact text / bytes (`on_text`, `on_frame`), and must never panic;
//! - `ignored` server steps (ids not live for the client, whatever their
//!   direction or validity) produce **no output at all**;
//! - a server step flagged `expectViolation` followed by a `reaction` makes
//!   the host send exactly that terminal error for that id (`unsupported` or
//!   `invalidParams`);
//! - a connection-level `malformed` server step (JSON limits, bad frame
//!   header) produces nothing, terminates nothing and is counted;
//! - a `connection` violation (app request before `core.capabilities`, a
//!   second core stream) closes the socket;
//! - every other server step is accepted: it never draws a violation
//!   reaction or a close.
//!
//! Client → server steps are the client's own work. The host produces lease
//! acks, snapshots, reactions and `cancelled` terminals itself; driver work
//! is scripted from the transcript like a live source would produce it:
//! `blobStart` opens a streamed item, each frame step writes its payload
//! (the host frames it as credit allows), the client terminal ends
//! production — and the host's own terminal must then state exactly the
//! transcript's items, byte counts and SHA-256. Progress, stream events,
//! download grants and `core.capabilities` snapshots go through the matching
//! host calls. Client steps flagged as violations describe a misbehaving
//! client and are not produced (a conforming host may refuse what that
//! client accepted — e.g. a download whose bytes miss the declared hash).

use hypen_engine::serialize::device::{
    registry, CapabilityOffer, DeviceErrorCode, DeviceMessage, DeviceResponse, ProgressState,
};
use hypen_renderer_desktop::device::{BlobSource, DeviceHost, HostOptions, HostOutput};
use serde_json::{json, Map, Value};
use std::path::Path;

fn transcripts_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("engine-compatibility-tests/fixtures/device/transcripts")
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn frame_bytes(frame: &Value) -> Vec<u8> {
    let mut bytes = hex_bytes(frame["hex"].as_str().unwrap_or(""));
    if let Some(fill) = frame.get("payloadFill") {
        let b = fill["byte"].as_u64().unwrap() as u8;
        let n = fill["length"].as_u64().unwrap() as usize;
        bytes.extend(std::iter::repeat_n(b, n));
    }
    bytes
}

fn step_id(step: &Value) -> Option<u32> {
    if let Some(id) = step
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_u64)
    {
        return u32::try_from(id).ok();
    }
    if let Some(id) = step
        .get("frame")
        .and_then(|f| f["header"].get("requestId"))
        .and_then(Value::as_u64)
    {
        return u32::try_from(id).ok();
    }
    let raw = step.get("raw")?.as_str()?;
    let at = raw.find("\"id\":")? + 5;
    let digits: String = raw[at..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn default_ack() -> Value {
    json!({
        "protocolVersion": 1,
        "binary": true,
        "capabilities": registry()
            .iter()
            .map(|c| json!({"name": c.name, "version": c.revisions.last().unwrap().version}))
            .collect::<Vec<_>>(),
    })
}

/// Terminal error responses among `outs`, as `(id, code)`.
fn responses(outs: &[HostOutput]) -> Vec<(u32, Option<DeviceErrorCode>)> {
    outs.iter()
        .filter_map(|o| match o {
            HostOutput::SendText(t) => match DeviceMessage::decode(t) {
                Ok(DeviceMessage::DeviceResponse(DeviceResponse { id, error, .. })) => {
                    Some((id, error.map(|e| e.code)))
                }
                Ok(_) => None,
                Err(e) => panic!("host sent an invalid device message {t}: {e}"),
            },
            _ => None,
        })
        .collect()
}

fn sends_anything(outs: &[HostOutput]) -> bool {
    outs.iter().any(|o| {
        matches!(
            o,
            HostOutput::SendText(_)
                | HostOutput::SendFrame(_)
                | HostOutput::Close { .. }
                | HostOutput::Start(_)
                | HostOutput::DownloadChunk { .. }
                | HostOutput::DownloadComplete { .. }
        )
    })
}

#[derive(Default, Debug)]
struct Stats {
    transcripts: usize,
    server_steps: usize,
    ignored: usize,
    reactions: usize,
    connection_level: usize,
    closes: usize,
    client_terminals: usize,
    uploads_verified: usize,
    downloads_verified: usize,
}

/// Ids whose client output the transcript shows misbehaving (an
/// attributable client → server violation): the server detects it; a
/// conforming host never produces it, so its own reaction is legitimate.
fn misbehaving_ids(steps: &[Value]) -> std::collections::HashSet<u32> {
    let mut ids = std::collections::HashSet::new();
    for (i, s) in steps.iter().enumerate() {
        if s["dir"] != "c2s" || s.get("expectViolation").is_none() {
            continue;
        }
        let next_reaction = steps
            .get(i + 1)
            .is_some_and(|n| n.get("reaction").and_then(Value::as_bool) == Some(true));
        let connection_level = s["expectViolation"] == "malformed"
            && !next_reaction
            && (s.get("raw").is_some() || s.get("frame").is_some());
        if !connection_level {
            if let Some(id) = step_id(s) {
                ids.insert(id);
            }
        }
    }
    ids
}

/// Extra item fields (e.g. file.pick `name`) of `channel` in the client's
/// later terminal result for `id`.
fn item_extra(steps: &[Value], from: usize, id: u32, channel: u64) -> Map<String, Value> {
    for s in &steps[from..] {
        let m = &s["message"];
        if s["dir"] == "c2s" && m["type"] == "deviceResponse" && step_id(s) == Some(id) {
            let items = m["result"]["items"].as_array().cloned().unwrap_or_default();
            for it in items {
                if it["channel"].as_u64() == Some(channel) {
                    let mut extra = it.as_object().cloned().unwrap_or_default();
                    for k in ["channel", "contentType", "bytes", "sha256"] {
                        extra.remove(k);
                    }
                    return extra;
                }
            }
            break;
        }
    }
    Map::new()
}

/// A result with its `items` ordered by channel (the item *set* is what
/// the protocol pins, not the order a client lists it in).
fn by_channel(result: &Value) -> Value {
    let mut r = result.clone();
    if let Some(items) = r.get_mut("items").and_then(Value::as_array_mut) {
        items.sort_by_key(|it| it["channel"].as_u64());
    }
    r
}

/// Poll until the host has nothing ready (bulk turns included).
fn pump(host: &mut DeviceHost, sink: &mut Vec<HostOutput>) {
    loop {
        let outs = host.poll();
        let empty = outs.is_empty();
        sink.extend(outs);
        if empty && !host.has_ready_work() {
            break;
        }
    }
}

/// The success terminal the host sent for `id`, if any.
fn sent_result(outs: &[HostOutput], id: u32) -> Option<Value> {
    outs.iter().find_map(|o| match o {
        HostOutput::SendText(t) => match DeviceMessage::decode(t) {
            Ok(DeviceMessage::DeviceResponse(r)) if r.id == id => r.result,
            _ => None,
        },
        _ => None,
    })
}

fn replay(doc: &Value, stats: &mut Stats) -> Result<(), String> {
    let name = doc["name"].as_str().unwrap_or("?").to_string();
    let steps = doc["steps"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = registry().iter().map(|c| c.name).collect();
    let mut host = DeviceHost::new(&names, HostOptions::default());
    host.attach();
    let ack = doc.get("ack").cloned().unwrap_or_else(default_ack);
    host.on_ack(Some(&ack.to_string()));
    let _ = host.poll();
    if host.selected().is_none() {
        return Err(format!(
            "{name}: the host refused the transcript's ack {ack}"
        ));
    }
    let misbehaving = misbehaving_ids(&steps);
    let mut snapshots_seen = std::collections::HashSet::new();
    let mut client_out: Vec<HostOutput> = Vec::new();
    let mut closed = false;
    for (i, step) in steps.iter().enumerate() {
        let at = format!("{name} step {i}");
        if closed {
            return Err(format!("{at}: steps continue after the connection closed"));
        }
        let dir = step["dir"].as_str().unwrap_or("");
        let violation = step.get("expectViolation").and_then(Value::as_str);
        let ignored = step.get("ignored").and_then(Value::as_bool) == Some(true);
        let next = steps.get(i + 1);
        let next_is_reaction =
            next.is_some_and(|n| n.get("reaction").and_then(Value::as_bool) == Some(true));
        let id = step_id(step);
        if dir == "s2c" {
            stats.server_steps += 1;
            let violations_before = host.connection_violations();
            if let Some(frame) = step.get("frame") {
                host.on_frame(&frame_bytes(frame), 0);
            } else if let Some(raw) = step.get("raw").and_then(Value::as_str) {
                host.on_text(raw, 0);
            } else {
                host.on_text(&step["message"].to_string(), 0);
            }
            let mut outs = Vec::new();
            pump(&mut host, &mut outs);
            let closes = outs.iter().any(|o| matches!(o, HostOutput::Close { .. }));
            if ignored {
                stats.ignored += 1;
                if sends_anything(&outs) {
                    return Err(format!("{at}: an ignored step produced output {outs:?}"));
                }
                continue;
            }
            match violation {
                Some("connection") => {
                    if !closes {
                        return Err(format!(
                            "{at}: connection violation did not close: {outs:?}"
                        ));
                    }
                    stats.closes += 1;
                    closed = true;
                }
                Some(category) if next_is_reaction => {
                    let reaction = next.unwrap();
                    let want = reaction["message"]["error"]["code"].clone();
                    let want: DeviceErrorCode = serde_json::from_value(want)
                        .map_err(|e| format!("{at}: reaction without an error code: {e}"))?;
                    let rid = step_id(reaction);
                    let got = responses(&outs);
                    if got != vec![(rid.unwrap(), Some(want))] {
                        return Err(format!(
                            "{at}: {category} violation: expected the reaction {want:?} for {rid:?}, got {got:?}"
                        ));
                    }
                    if closes {
                        return Err(format!("{at}: a request-level violation closed the socket"));
                    }
                    stats.reactions += 1;
                }
                Some("malformed") => {
                    // Attributable to no request (D3): nothing happens, the
                    // request its id seems to name stays live.
                    if sends_anything(&outs) {
                        return Err(format!(
                            "{at}: connection-level violation produced {outs:?}"
                        ));
                    }
                    if host.connection_violations() != violations_before + 1 {
                        return Err(format!("{at}: connection-level violation not counted"));
                    }
                    if let Some(id) = id {
                        if !host.is_live(id)
                            && steps[..i].iter().any(|s| {
                                s["dir"] == "s2c"
                                    && s["message"]["type"] == "deviceRequest"
                                    && step_id(s) == Some(id)
                            })
                            && !steps[..i].iter().any(|s| {
                                s["dir"] == "c2s"
                                    && s["message"]["type"] == "deviceResponse"
                                    && step_id(s) == Some(id)
                            })
                        {
                            return Err(format!(
                                "{at}: a connection-level violation ended request {id}"
                            ));
                        }
                    }
                    stats.connection_level += 1;
                }
                Some(other) => {
                    return Err(format!("{at}: {other} violation without a reaction step"));
                }
                None => {
                    // A valid server step never draws a violation reaction —
                    // unless the transcript's client misbehaves on that id
                    // (a conforming host refuses what that client accepted).
                    let bad: Vec<_> = responses(&outs)
                        .into_iter()
                        .filter(|(rid, code)| {
                            !misbehaving.contains(rid)
                                && matches!(
                                    code,
                                    Some(DeviceErrorCode::InvalidParams)
                                        | Some(DeviceErrorCode::Unsupported)
                                )
                        })
                        .collect();
                    if !bad.is_empty() || closes {
                        return Err(format!("{at}: a valid server step was refused: {outs:?}"));
                    }
                    stats.downloads_verified += outs
                        .iter()
                        .filter(|o| matches!(o, HostOutput::DownloadComplete { .. }))
                        .count();
                }
            }
            client_out.extend(outs);
        } else {
            // Client → server: the client's own work. Keep the replay's
            // client in step with it (see the module docs).
            if step.get("reaction").and_then(Value::as_bool) == Some(true) {
                continue; // produced (and checked) above
            }
            if ignored || violation.is_some() {
                // A racing or misbehaving client: not produced. Its own
                // terminal still retires the id on the client.
                if step["message"]["type"] == "deviceResponse" {
                    if let Some(id) = id.filter(|&id| host.is_live(id)) {
                        host.fail(id, DeviceErrorCode::Internal, Some("replay".into()));
                        pump(&mut host, &mut Vec::new());
                    }
                }
                continue;
            }
            let Some(id) = id else { continue };
            if !host.is_live(id) {
                continue; // already settled by the host itself
            }
            if let Some(frame) = step.get("frame") {
                let bytes = frame_bytes(frame);
                let channel = frame["header"]["channel"].as_u64().unwrap() as u16;
                host.write_blob(id, channel, bytes[12..].to_vec());
                pump(&mut host, &mut client_out);
                continue;
            }
            let Some(msg) = step.get("message") else {
                continue;
            };
            match msg["type"].as_str() {
                Some("deviceResponse") => {
                    stats.client_terminals += 1;
                    if let Some(err) = msg.get("error") {
                        let code: DeviceErrorCode =
                            serde_json::from_value(err["code"].clone()).unwrap();
                        let detail = err.get("platformDetail").and_then(Value::as_str);
                        host.fail(id, code, detail.map(str::to_string));
                        pump(&mut host, &mut client_out);
                        continue;
                    }
                    let mut result: Map<String, Value> =
                        msg["result"].as_object().cloned().unwrap_or_default();
                    let upload = result.remove("items").is_some() | result.remove("item").is_some();
                    let simulated = msg.get("simulated").is_some();
                    let mut outs = Vec::new();
                    host.succeed(id, result, simulated);
                    pump(&mut host, &mut outs);
                    if upload {
                        // The host's own terminal states the items it
                        // actually framed: it must equal the transcript's.
                        match sent_result(&outs, id) {
                            Some(r) if by_channel(&r) == by_channel(&msg["result"]) => {
                                stats.uploads_verified += 1
                            }
                            Some(r) => {
                                return Err(format!(
                                    "{at}: upload terminal {r} differs from {}",
                                    msg["result"]
                                ))
                            }
                            None if host.is_live(id) => {} // bytes still wait for credit
                            None => {
                                return Err(format!(
                                    "{at}: upload ended without a result: {outs:?}"
                                ))
                            }
                        }
                    }
                    client_out.extend(outs);
                }
                Some("deviceEvent") => {
                    if let Some(grant) = msg["control"].get("grant").and_then(Value::as_u64) {
                        host.grant_download(id, grant);
                    } else if let Some(event) = msg.get("event") {
                        match event["kind"].as_str() {
                            Some("blobStart") => {
                                let channel = event["channel"].as_u64().unwrap();
                                let extra = item_extra(&steps, i, id, channel);
                                host.open_blob(
                                    id,
                                    event["contentType"].as_str().unwrap(),
                                    extra,
                                    BlobSource::Stream {
                                        declared: event["bytes"].as_u64(),
                                    },
                                );
                            }
                            Some("progress") => {
                                let state = match event["state"].as_str() {
                                    Some("running") => ProgressState::Running,
                                    _ => ProgressState::PendingConsent,
                                };
                                host.progress(id, state);
                            }
                            _ if event.get("capabilities").is_some() => {
                                // The first snapshot of a core stream is the
                                // one the host sent by itself on open.
                                if snapshots_seen.insert(id) {
                                    continue;
                                }
                                let offers: Vec<CapabilityOffer> =
                                    serde_json::from_value(event["capabilities"].clone()).unwrap();
                                host.republish(&offers);
                            }
                            _ => host.emit(id, event.clone()),
                        }
                    }
                    pump(&mut host, &mut client_out);
                }
                _ => {}
            }
        }
    }
    stats.transcripts += 1;
    Ok(())
}

#[test]
fn desktop_host_replays_every_shared_wire_transcript_as_the_client() {
    let dir = transcripts_dir();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    entries.sort();
    let mut stats = Stats::default();
    let mut failures = Vec::new();
    let mut handshake = 0;
    for path in entries {
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        if doc.get("steps").is_none() {
            handshake += 1;
            continue; // handshake-selection fixtures: covered by the unit tests
        }
        if let Err(e) = replay(&doc, &mut stats) {
            failures.push(e);
        }
    }
    eprintln!("{stats:?}, handshake fixtures {handshake}");
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(stats.transcripts >= 100, "{stats:?}");
    assert!(stats.reactions >= 25, "{stats:?}");
    assert!(stats.connection_level >= 1, "{stats:?}");
    assert!(stats.uploads_verified >= 10, "{stats:?}");
    assert!(stats.downloads_verified >= 3, "{stats:?}");
    assert!(stats.closes >= 2, "{stats:?}");
}
