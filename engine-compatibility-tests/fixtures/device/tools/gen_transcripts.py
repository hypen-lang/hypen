#!/usr/bin/env python3
"""Generates every file in engine-compatibility-tests/fixtures/device/transcripts/.

This script owns the whole directory: it writes every wire transcript and
handshake-selection fixture, and deletes any *.json it did not write (so a
transcript removed here disappears from disk and from every runner).

Format and semantics: ../README.md. In short:

- Every wire transcript runs on one physical connection whose negotiated
  `sessionAck.device` is `ack` (default: every registry capability at its
  highest revision, binary true) and whose server advertisement is
  `serverCapabilities` (default: the ack's selection). Unless a transcript
  opens it itself, a `core.capabilities` stream (id 1) is opened first: app
  requests are only valid after it (RFC 001 §2.2). Transcripts written with
  app ids starting at 1 are shifted up by one for that prelude.
- `expectViolation` flags the offending step; the step after a request-level
  violation is its `reaction` (a client terminal error, or a server cancel),
  and the transcript may continue after it (RFC 001 §2.1, decision D8).
"""
import copy
import hashlib
import json
import os
import struct

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "transcripts")
MIB = 1024 * 1024
KIB = 1024
CHUNK = 64 * KIB
U32_MAX = 4294967295
DEVICE_TYPES = ("deviceRequest", "deviceResponse", "deviceEvent")


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------------ builders
def owner(mid="profile-7", act=3):
    return {"moduleInstanceId": mid, "activationId": act}


def request(id, capability, params, credit=0, timeout=300000, own=None, lifetime="activation", version=1):
    return {"type": "deviceRequest", "id": id, "capability": capability, "version": version,
            "owner": own if own is not None else owner(), "lifetime": lifetime,
            "timeoutMs": timeout, "initialCredit": credit, "params": params}


def gp(id, max_count=1, credit=65536, own=None, **kw):
    return request(id, "gallery.pick", {"mediaTypes": ["photo"], "maxCount": max_count}, credit, own=own, **kw)


def pq(id, perm="microphone", own=None, **kw):
    kw.setdefault("timeout", 30000)
    return request(id, "permission.query", {"permission": perm}, 0, own=own, **kw)


def pr(id, perm="camera", own=None, **kw):
    return request(id, "permission.request", {"permission": perm}, 0, own=own, **kw)


def bt(id, credit=64, own=None, **kw):
    kw.setdefault("timeout", 600000)
    return request(id, "bluetooth.scan", {}, credit, own=own, **kw)


def cc(id, credit=8, **kw):
    return request(id, "core.capabilities", {}, credit, timeout=86400000, own={"connection": True},
                   lifetime="connection", **kw)


def fs(id, data, name="report.txt", ct="text/plain", credit=0, **kw):
    return request(id, "file.save", {"channel": 0, "name": name, "contentType": ct,
                                     "bytes": len(data), "sha256": sha(data)}, credit, **kw)


def fp(id, max_count=1, credit=65536, **kw):
    return request(id, "file.pick", {"accept": ["application/pdf"], "maxCount": max_count}, credit, **kw)


def mic(id, credit=16, max_duration_ms=None, channels=None, sample_rate=16000, **kw):
    params = {"sampleRate": sample_rate, "format": "pcm16"}
    if max_duration_ms is not None:
        params["maxDurationMs"] = max_duration_ms
    if channels is not None:
        params["channels"] = channels
    return request(id, "mic.record", params, credit, timeout=600000, **kw)


def cam(id, mode="photo", credit=65536, facing=None, max_duration_ms=None, **kw):
    params = {"mode": mode}
    if facing is not None:
        params["facing"] = facing
    if max_duration_ms is not None:
        params["maxDurationMs"] = max_duration_ms
    kw.setdefault("timeout", 600000)
    return request(id, "camera.capture", params, credit, **kw)


def bsel(id, services=None, name_prefix=None, **kw):
    params = {}
    if services is not None:
        params["services"] = services
    if name_prefix is not None:
        params["namePrefix"] = name_prefix
    return request(id, "bluetooth.select", params, 0, **kw)


def result(id, r, **kw):
    return dict({"type": "deviceResponse", "id": id, "result": r}, **kw)


def error(id, code, detail=None, **kw):
    e = {"code": code}
    if detail is not None:
        e["platformDetail"] = detail
    return dict({"type": "deviceResponse", "id": id, "error": e}, **kw)


def event(id, ev):
    return {"type": "deviceEvent", "id": id, "event": ev}


def control(id, c):
    return {"type": "deviceEvent", "id": id, "control": c}


def blob_start(id, ch, data_or_len=None, ct="image/jpeg"):
    """`data_or_len=None` announces an item of unknown length (no `bytes`)."""
    ev = {"kind": "blobStart", "channel": ch, "contentType": ct}
    if data_or_len is not None:
        ev["bytes"] = data_or_len if isinstance(data_or_len, int) else len(data_or_len)
    return event(id, ev)


def progress(id, state):
    return event(id, {"kind": "progress", "state": state})


def item(ch, data, ct="image/jpeg", sha256=None, nbytes=None):
    return {"channel": ch, "contentType": ct, "bytes": len(data) if nbytes is None else nbytes,
            "sha256": sha256 or sha(data)}


def snapshot(*caps):
    return {"capabilities": [{"name": n, "versions": [1]} for n in caps]}


def s2c(msg, **flags):
    return dict({"dir": "s2c", "message": msg}, **flags)


def c2s(msg, **flags):
    return dict({"dir": "c2s", "message": msg}, **flags)


def raw(dir, text, **flags):
    json.loads(text)  # must be JSON text (duplicate keys collapse silently here)
    return dict({"dir": dir, "raw": text}, **flags)


def header_bytes(id, ch, seq, version=1, flags=0):
    return struct.pack("<BBHII", version, flags, ch, id, seq)


def frame(dir, id, ch, seq, payload, version=1, flags=0, **extra):
    head = {"version": version, "flags": flags, "channel": ch, "requestId": id, "seq": seq}
    return dict({"dir": dir, "frame": {"header": head,
                                       "hex": (header_bytes(id, ch, seq, version, flags) + payload).hex()}},
                **extra)


def fill_frame(dir, id, ch, seq, length, byte=0, **extra):
    """A frame whose payload is `length` copies of `byte` (README: payloadFill)."""
    head = {"version": 1, "flags": 0, "channel": ch, "requestId": id, "seq": seq}
    return dict({"dir": dir, "frame": {"header": head, "hex": header_bytes(id, ch, seq).hex(),
                                       "payloadFill": {"byte": byte, "length": length}}}, **extra)


# ------------------------------------------------------------------ violations and reactions
AUTO = object()


def reaction_for(step, category):
    """The wire reaction RFC 001 §2.1 / D8 requires after a violation, or None.

    - `malformed` frames (bad header) and messages that cannot be attributed
      to a request, and `connection` violations, have no reaction.
    - A violation detected by the client (s2c step) is answered with a
      terminal error: `unsupported` for an unsupported revision, else
      `invalidParams`.
    - A violation detected by the server (c2s step) is answered with a
      cancel, unless the offending step is itself the client's terminal
      response (the server then settles locally and sends nothing).
    """
    if category == "connection":
        return None
    if "frame" in step:
        if category == "malformed":
            return None
        id, is_response = step["frame"]["header"]["requestId"], False
    elif "message" in step:
        msg = step["message"]
        id = msg.get("id")
        attributable = (isinstance(msg, dict) and msg.get("type") in DEVICE_TYPES
                        and isinstance(id, int) and not isinstance(id, bool) and 1 <= id <= U32_MAX)
        if not attributable:
            return None
        is_response = msg["type"] == "deviceResponse"
    else:
        raise ValueError("raw steps need an explicit reaction")
    if step["dir"] == "s2c":
        return c2s(error(id, "unsupported" if category == "unsupported" else "invalidParams"), reaction=True)
    if is_response:
        return None
    return s2c(control(id, {"cancel": True}), reaction=True)


def bad(step, category, reaction=AUTO):
    """The offending step plus its reaction step (if any)."""
    flagged = dict(step)
    flagged["expectViolation"] = category
    r = reaction_for(step, category) if reaction is AUTO else reaction
    return [flagged] + ([r] if r is not None else [])


# ------------------------------------------------------------------ writing
WRITTEN = set()


def shift_step(step, by):
    step = copy.deepcopy(step)
    if "message" in step:
        step["message"]["id"] += by
    elif "frame" in step:
        f = step["frame"]
        h = f["header"]
        payload = bytes.fromhex(f["hex"])[12:]
        h["requestId"] += by
        f["hex"] = (header_bytes(h["requestId"], h["channel"], h["seq"], h["version"], h["flags"]) + payload).hex()
    else:
        raise ValueError("cannot shift a raw step: write it with ids starting at 2")
    return step


def step_ids(step):
    if "message" in step:
        return [step["message"]["id"]]
    if "frame" in step:
        return [step["frame"]["header"]["requestId"]]
    return []


def opens_core(step):
    m = step.get("message")
    return (step["dir"] == "s2c" and isinstance(m, dict) and m.get("type") == "deviceRequest"
            and m.get("capability") == "core.capabilities")


def dump(path, doc, compact_steps=False):
    with open(path, "w") as f:
        if not compact_steps:
            json.dump(doc, f, indent=2)
            f.write("\n")
            return
        # Bulk transcripts: one step per line keeps the file small and diffable.
        head = {k: v for k, v in doc.items() if k != "steps"}
        f.write("{\n")
        for k, v in head.items():
            f.write(f"  {json.dumps(k)}: {json.dumps(v)},\n")
        f.write('  "steps": [\n')
        for i, step in enumerate(doc["steps"]):
            sep = "," if i + 1 < len(doc["steps"]) else ""
            f.write(f"    {json.dumps(step, separators=(',', ':'))}{sep}\n")
        f.write("  ]\n}\n")


def write(name, description, steps, ack=None, server=None, prelude=True, compact=False):
    """Write one wire transcript (see module doc for the prelude rule)."""
    assert name not in WRITTEN, name
    steps = list(steps)
    if prelude and not opens_core(steps[0]):
        ids = [i for s in steps for i in step_ids(s) if isinstance(i, int)]
        if ids and min(ids) <= 1:
            steps = [shift_step(s, 1) for s in steps]
        steps = [s2c(cc(1))] + steps
    doc = {"name": name, "description": description, "protocol": 1}
    if ack is not None:
        doc["ack"] = ack
    if server is not None:
        doc["serverCapabilities"] = server
    doc["steps"] = steps
    dump(os.path.join(ROOT, name + ".json"), doc, compact_steps=compact)
    WRITTEN.add(name)


def write_handshake(name, description, hello, server_pv, server_binary, server_caps, expect_ack):
    assert name not in WRITTEN, name
    doc = {"name": name, "description": description, "hello": hello,
           "serverProtocolVersions": server_pv, "serverBinary": server_binary,
           "serverCapabilities": server_caps, "expectAck": expect_ack}
    dump(os.path.join(ROOT, name + ".json"), doc)
    WRITTEN.add(name)


PHOTO = b"hello-hypen-photo"
SECOND = b"second-image"
PDF = b"%PDF-1.7 hypen"
SAVED = b"hypen-saved"
AUDIO = bytes(range(32))
EMPTY = b""
CORE = "core.capabilities"
ALL = [CORE, "bluetooth.scan", "bluetooth.select", "camera.capture", "file.pick", "file.save",
       "gallery.pick", "mic.record", "permission.query", "permission.request"]
JPEG = b"\xff\xd8\xff\xe0hypen-camera-jpeg\xff\xd9"
WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3]) + b"hypen-camera-webm-video-cluster"
# 48 kHz stereo PCM16, interleaved little-endian L/R frames (4 bytes each).
STEREO = b"".join(struct.pack("<hh", 100 * i, -100 * i) for i in range(24))
HR_UUID = "0000180d-0000-1000-8000-00805f9b34fb"


def ack_of(*names, binary=True):
    return {"protocolVersion": 1, "binary": binary,
            "capabilities": [{"name": n, "version": 1} for n in names]}


# =================================================================== handshake selection
write_handshake(
    "handshake-new-client-old-server",
    "Newer client offers gallery.pick and permission.query revisions 1 and 2, plus a capability the old "
    "server lacks. Selection pins revision 1 and drops the unknown name. The server lacks the binary "
    "profile, so binary is false for both sides and binary-plane revisions (gallery.pick) are not "
    "selectable (RFC 001 §2.2 rule c): supports(\"gallery.pick\") is false on this connection.",
    {"protocolVersions": [1, 2], "binary": True,
     "capabilities": [{"name": CORE, "versions": [1]}, {"name": "gallery.pick", "versions": [1, 2]},
                      {"name": "file.save", "versions": [1]}, {"name": "permission.query", "versions": [1, 2]}]},
    [1], False,
    [{"name": CORE, "versions": [1]}, {"name": "gallery.pick", "versions": [1]},
     {"name": "permission.query", "versions": [1]}],
    {"protocolVersion": 1, "binary": False,
     "capabilities": [{"name": CORE, "version": 1}, {"name": "permission.query", "version": 1}]})
write_handshake(
    "handshake-no-common-protocol",
    "No common protocol version: device access is disabled entirely and UI-only operation continues. "
    "No device traffic may be sent.",
    {"protocolVersions": [2], "binary": True, "capabilities": [{"name": CORE, "versions": [1]}]},
    [1], True, [{"name": CORE, "versions": [1]}], None)
write_handshake(
    "handshake-old-client-new-server",
    "Old client offers gallery.pick v1 only; newer server implements v1 and v2. Selection pins v1; "
    "server-only capabilities are excluded from the intersection.",
    {"protocolVersions": [1], "binary": True,
     "capabilities": [{"name": CORE, "versions": [1]}, {"name": "gallery.pick", "versions": [1]}]},
    [1], True,
    [{"name": CORE, "versions": [1]}, {"name": "gallery.pick", "versions": [1, 2]},
     {"name": "mic.record", "versions": [1]}],
    {"protocolVersion": 1, "binary": True,
     "capabilities": [{"name": CORE, "version": 1}, {"name": "gallery.pick", "version": 1}]})
write_handshake(
    "handshake-invalid-hello-disables-device",
    "A hello.device that fails handshake-v1 (here: the reserved protocol version 0) disables device "
    "access: select_device_ack validates the hello before selecting (decision D7).",
    {"protocolVersions": [0, 1], "binary": True, "capabilities": [{"name": CORE, "versions": [1]}]},
    [1], True, [{"name": CORE, "versions": [1]}], None)

# =================================================================== positive
write("gallery-pick-upload",
      "Happy-path unary upload: request with bounded initial credit, blobStart before bytes, credit-paced "
      "chunk, terminal result whose item set the server verifies (count + sha256) before resolving the "
      "handler.",
      [s2c(gp(1)),
       c2s(blob_start(1, 0, PHOTO)),
       frame("c2s", 1, 0, 0, PHOTO),
       c2s(result(1, {"items": [item(0, PHOTO)]}))])

write("gallery-pick-denied",
      "Consent refusal is an immediate terminal error; platformDetail is diagnostic only and portable "
      "handlers must not branch on it.",
      [s2c(gp(2)),
       c2s(error(2, "denied", "user-declined"))])

write("cancel-race",
      "Server cancellation races the client's in-flight success. The server retires id 3 at send and "
      "settles locally as cancelled; the late terminal response is ignored under the unknown/stale-id "
      "rule. Both sides settle exactly once and the server never sends a deviceResponse.",
      [s2c(pr(3, perm="notifications", own=owner("settings-1", 1))),
       s2c(control(3, {"cancel": True})),
       c2s(result(3, {"status": "granted"}), ignored=True)])

write("file-save-download",
      "Server-to-client download: initialCredit MUST be zero; the client grants credit only after consent "
      "and destination selection; the terminal response is the client-verified write receipt.",
      [s2c(fs(5, SAVED, own=owner("reports-1", 2))),
       c2s(control(5, {"grant": 65536})),
       frame("s2c", 5, 0, 0, SAVED),
       c2s(result(5, {"bytesWritten": 11}))])

write("lease",
      "Credit-independent liveness: renewals start at sequence 1 immediately after the request and continue "
      "every 5s; the client echoes each exactly, even while pending consent with no data flowing. Data "
      "frames and grants never refresh the lease. The final client terminal arrives after the server's "
      "cancel retired id 4: the server drops it under the unknown/stale-id rule (flagged ignored).",
      [s2c(bt(4, own=owner("devices-2", 5))),
       s2c(control(4, {"renewLease": 1})),
       c2s(control(4, {"leaseAck": 1})),
       c2s(event(4, {"device": {"id": "aa:bb:cc:dd:ee:ff", "name": "Speaker", "rssi": -41}})),
       s2c(control(4, {"renewLease": 2})),
       c2s(control(4, {"leaseAck": 2})),
       s2c(control(4, {"cancel": True})),
       c2s(result(4, {}), ignored=True)])

write("simulated-result",
      "A fake host stamps every result simulated:true; the flag has a protocol-level schema shared by every "
      "capability and is never omitted by fakes.",
      [s2c(pq(7, own=owner("settings-1", 1))),
       c2s(result(7, {"status": "prompt"}, simulated=True))])

write("capabilities-replacement",
      "Connection-owned core.capabilities stream: opened once after selection, before module callbacks can "
      "request device work. Every event is a complete replacement advertisement; existing requests keep "
      "their pinned revision.",
      [s2c(cc(6)),
       c2s(event(6, snapshot(CORE, "gallery.pick", "bluetooth.scan"))),
       c2s(event(6, snapshot(CORE, "gallery.pick")))])

write("owner-lifetimes",
      "Two instances of one module (editor) carry distinct moduleInstanceIds and stay isolated. "
      "Deactivating editor-1 (activation 1) sweeps its work: the server cancels every activation-owned "
      "id (2, 4), retires them and settles locally; editor-2's request 3 is unaffected. Late client "
      "messages for swept ids are ignored. Reactivation (activationId 2) starts fresh work under a new "
      "id; old work is never resurrected, and activationIds never go backwards per module instance.",
      [s2c(pq(1, own=owner("editor-1", 1))),
       s2c(pq(2, own=owner("editor-2", 1))),
       s2c(pr(3, own=owner("editor-1", 1))),
       s2c(control(1, {"cancel": True})),
       s2c(control(3, {"cancel": True})),
       c2s(result(2, {"status": "granted"})),
       c2s(result(1, {"status": "granted"}), ignored=True),
       c2s(error(3, "cancelled"), ignored=True),
       s2c(pq(4, own=owner("editor-1", 2))),
       c2s(result(4, {"status": "prompt"}))])

write("core-capabilities-reopen",
      "Planned reopening of the connection-owned core.capabilities stream before its finite deadline: "
      "the server replenishes snapshot credit independently of app handlers, then retires the old "
      "stream (cancel) before opening a new one under a new id. The new stream's first event is a "
      "fresh full snapshot; the old stream's late snapshot and terminal are ignored.",
      [s2c(cc(1, credit=1)),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(event(1, snapshot(CORE, "gallery.pick"))),
       s2c(control(1, {"grant": 1})),
       s2c(control(1, {"cancel": True})),
       s2c(cc(2)),
       c2s(event(1, snapshot(CORE)), ignored=True),
       c2s(error(1, "cancelled"), ignored=True),
       c2s(event(2, snapshot(CORE, "gallery.pick", "permission.query")))])

write("revision-pinning",
      "A replacement advertisement arrives mid-upload and removes gallery.pick. Advertisement changes "
      "alone do not cancel work: the in-flight request keeps its pinned revision and completes with "
      "verified bytes. Only subsequent requests use the new selection (a gallery.pick request now would "
      "be refused with unsupported, see violation-request-after-removal).",
      [s2c(cc(1)),
       c2s(event(1, snapshot(CORE, "gallery.pick", "permission.query"))),
       s2c(gp(2)),
       c2s(blob_start(2, 0, PHOTO)),
       frame("c2s", 2, 0, 0, PHOTO[:6]),
       c2s(event(1, snapshot(CORE, "permission.query"))),
       frame("c2s", 2, 0, 1, PHOTO[6:]),
       c2s(result(2, {"items": [item(0, PHOTO)]})),
       s2c(pq(3)),
       c2s(result(3, {"status": "granted"}))])

write("capabilities-removal-and-readd",
      "The live selection follows the latest core.capabilities snapshot: each snapshot recomputes it "
      "as the negotiated ack restricted to the revisions the snapshot lists (the ack is the ceiling; see "
      "violation-snapshot-cannot-widen-ack). gallery.pick disappears and comes back (hardware detached "
      "and reattached); requests use whatever the latest snapshot allows.",
      [s2c(cc(1)),
       c2s(event(1, snapshot(CORE, "gallery.pick", "permission.query"))),
       c2s(event(1, snapshot(CORE, "permission.query"))),
       s2c(pq(2)),
       c2s(result(2, {"status": "granted"})),
       c2s(event(1, snapshot(CORE, "gallery.pick", "permission.query"))),
       s2c(gp(3)),
       c2s(error(3, "cancelled", "picker-dismissed"))])

write("ids-stale-and-duplicate",
      "Unknown/stale id rules (§2.1): the client drops a duplicate request id and an older id without "
      "executing them (high-water mark); the server ignores a response for an id it never sent, a "
      "second terminal for a retired id, and events after the terminal; the client ignores a renewal "
      "for an unknown id. A fresh id above the high-water mark proceeds normally.",
      [s2c(pq(5)),
       s2c(pq(5), ignored=True),
       s2c(pq(4), ignored=True),
       c2s(result(9, {"status": "granted"}), ignored=True),
       s2c(control(9, {"renewLease": 1}), ignored=True),
       c2s(result(5, {"status": "granted"})),
       c2s(result(5, {"status": "denied"}), ignored=True),
       c2s(progress(5, "running"), ignored=True),
       s2c(pq(6)),
       c2s(result(6, {"status": "prompt"}))])

write("unknown-ids-ignored-in-any-direction",
      "Liveness is checked before direction (decision D8): a message for an id that is not live for its "
      "receiver is ignored whatever its direction or validity, never a violation. Wrong-direction "
      "messages (a client cancel, a server deviceResponse, a client deviceRequest, a server leaseAck, a "
      "client renewLease, a server capability event), a client grant, a frame, and a well-formed-JSON "
      "but schema-invalid message all target never-requested ids here and are dropped. The live "
      "request 2 is unaffected.",
      [s2c(pq(2)),
       c2s(control(99, {"cancel": True}), ignored=True),
       s2c(result(99, {"status": "granted"}), ignored=True),
       c2s(pq(98), ignored=True),
       s2c(control(99, {"leaseAck": 1}), ignored=True),
       c2s(control(99, {"renewLease": 1}), ignored=True),
       s2c(progress(99, "running"), ignored=True),
       c2s(control(99, {"grant": 1}), ignored=True),
       frame("c2s", 99, 0, 0, PHOTO, ignored=True),
       frame("s2c", 99, 0, 0, PHOTO, ignored=True),
       c2s(control(99, {"cancel": False}), ignored=True),
       s2c(control(99, {"grant": 0}), ignored=True),
       c2s(result(2, {"status": "granted"}))])

write("lease-edge-cases",
      "Lease liveness during a zero-credit download awaiting consent: renewals and acks flow while "
      "no data can (initialCredit 0, no grant yet). A duplicate or older leaseAck is legal but "
      "refreshes nothing. The first renewal is sequence 1; later ones may skip (an unsent renewal is "
      "replaced by the latest), but never repeat or decrease. A renewal after the terminal targets a "
      "retired id and is ignored.",
      [s2c(fs(1, SAVED)),
       s2c(control(1, {"renewLease": 1})),
       c2s(progress(1, "pendingConsent")),
       c2s(control(1, {"leaseAck": 1})),
       s2c(control(1, {"renewLease": 2})),
       c2s(control(1, {"leaseAck": 2})),
       c2s(control(1, {"leaseAck": 2})),
       c2s(control(1, {"leaseAck": 1})),
       s2c(control(1, {"renewLease": 4})),
       c2s(control(1, {"leaseAck": 4})),
       c2s(progress(1, "running")),
       c2s(control(1, {"grant": 65536})),
       frame("s2c", 1, 0, 0, SAVED),
       c2s(result(1, {"bytesWritten": len(SAVED)})),
       s2c(control(1, {"renewLease": 5}), ignored=True)])

write("termination-races",
      "Every operation settles exactly once and the server never sends a deviceResponse. (1) Client "
      "deadline wins: terminal timeout. (2) Server deadline wins: the server cancels, retires the id and "
      "settles locally; the client's own timeout is ignored. (3) Client-initiated cancellation is a "
      "terminal cancelled response with no server reply. (4) An undismissable OS dialog finishes after "
      "the server cancelled: a conforming client uploads nothing and its late cancelled terminal is "
      "ignored. (5) A non-conforming client that uploads anyway: blobStart, bytes and result for the "
      "retired id are all ignored by the server.",
      [s2c(pr(1, timeout=30000)),
       c2s(error(1, "timeout")),
       s2c(pr(2, timeout=30000)),
       s2c(control(2, {"cancel": True})),
       c2s(error(2, "timeout"), ignored=True),
       s2c(gp(3)),
       c2s(error(3, "cancelled", "picker-dismissed")),
       s2c(gp(4)),
       s2c(control(4, {"cancel": True})),
       c2s(error(4, "cancelled"), ignored=True),
       s2c(gp(5)),
       s2c(control(5, {"cancel": True})),
       c2s(blob_start(5, 0, PHOTO), ignored=True),
       frame("c2s", 5, 0, 0, PHOTO, ignored=True),
       c2s(result(5, {"items": [item(0, PHOTO)]}), ignored=True)])

write("consent-and-progress",
      "Host-owned consent: optional progress events report pendingConsent then running (they consume no "
      "credit and server correctness never depends on them; they never go back to pendingConsent); the "
      "lease stays live while consent is pending; a permission.request succeeds. While one prompt is "
      "pending, a second prompting request is throttled; the pending one then resolves (here: denied by "
      "the user).",
      [s2c(pr(1)),
       c2s(progress(1, "pendingConsent")),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(progress(1, "running")),
       c2s(progress(1, "running")),
       c2s(result(1, {"status": "granted"})),
       s2c(gp(2)),
       c2s(progress(2, "pendingConsent")),
       s2c(pr(3, perm="microphone")),
       c2s(error(3, "throttled")),
       c2s(error(2, "denied", "user-declined"))])

write("gallery-pick-multi-item",
      "Multi-item upload with credit pacing: both items are announced before their bytes, chunks "
      "interleave across channels with contiguous per-channel seq, the sender reports paused when "
      "credit is exhausted (and sends nothing until it reports paused:false), the receiver grants more, "
      "and the terminal item set is verified per channel (count, contentType, bytes, sha256).",
      [s2c(gp(1, max_count=2, credit=16)),
       c2s(blob_start(1, 0, PHOTO)),
       c2s(blob_start(1, 1, SECOND, ct="image/png")),
       frame("c2s", 1, 0, 0, PHOTO[:12]),
       frame("c2s", 1, 1, 0, SECOND[:4]),
       c2s(control(1, {"paused": True})),
       s2c(control(1, {"grant": 32})),
       c2s(control(1, {"paused": False})),
       frame("c2s", 1, 0, 1, PHOTO[12:]),
       frame("c2s", 1, 1, 1, SECOND[4:]),
       c2s(result(1, {"items": [item(1, SECOND, ct="image/png"), item(0, PHOTO)]}))])

write("gallery-pick-undeclared-size",
      "Blob sizes are optional (RFC 001 §2.4, decision D5). Item 0 is an existing file and declares its "
      "exact size; item 1 is being transcoded and omits `bytes`: the sender just streams. The receiver "
      "enforces maxItemBytes and its budget as bytes arrive; the item ends with the terminal result, "
      "which states each item's actual bytes and sha256 (equal to what was received).",
      [s2c(gp(1, max_count=2)),
       c2s(blob_start(1, 0, PHOTO)),
       c2s(blob_start(1, 1, None, ct="image/png")),
       frame("c2s", 1, 1, 0, SECOND[:5]),
       frame("c2s", 1, 0, 0, PHOTO),
       frame("c2s", 1, 1, 1, SECOND[5:]),
       c2s(result(1, {"items": [item(0, PHOTO), item(1, SECOND, ct="image/png")]}))])

write("empty-item-no-frames",
      "A zero-byte item sends no frames (decision D2): it is announced by blobStart with bytes 0 (or with "
      "no size) and completed by the terminal item with bytes 0 and the SHA-256 of the empty string. A "
      "zero-length frame is never valid (violation-empty-frame).",
      [s2c(gp(1, max_count=3)),
       c2s(blob_start(1, 0, EMPTY, ct="text/plain")),
       c2s(blob_start(1, 1, None, ct="text/plain")),
       c2s(blob_start(1, 2, PHOTO)),
       frame("c2s", 1, 2, 0, PHOTO),
       c2s(result(1, {"items": [item(0, EMPTY, ct="text/plain"), item(1, EMPTY, ct="text/plain"),
                                item(2, PHOTO)]}))])

write("file-pick-upload",
      "file.pick unary upload: blobStart, bytes, and a terminal item carrying the file name.",
      [s2c(fp(1)),
       c2s(blob_start(1, 0, PDF, ct="application/pdf")),
       frame("c2s", 1, 0, 0, PDF),
       c2s(result(1, {"items": [{"channel": 0, "name": "doc.pdf", "contentType": "application/pdf",
                                 "bytes": len(PDF), "sha256": sha(PDF)}]}))])

write("mic-record-stream",
      "mic.record binary stream with a declared size (legal when the sender already knows it, e.g. a "
      "completed recording): one announced channel, credit-paced chunks, a paused/resumed transition, "
      "lease renewal, and a terminal result with the verified item. A live recording does not know its "
      "size: see mic-record-undeclared-stream.",
      [s2c(mic(1)),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(blob_start(1, 0, AUDIO, ct="audio/L16")),
       frame("c2s", 1, 0, 0, AUDIO[:16]),
       c2s(control(1, {"paused": True})),
       s2c(control(1, {"grant": 16})),
       c2s(control(1, {"paused": False})),
       frame("c2s", 1, 0, 1, AUDIO[16:]),
       c2s(result(1, {"durationMs": 1, "item": item(0, AUDIO, ct="audio/L16")}))])

write("mic-record-undeclared-stream",
      "Live microphone capture (decision D5): params carry an optional maxDurationMs recording limit, "
      "never a size; blobStart omits `bytes`; chunks stream under credit with a paused/resumed "
      "transition; the user stops early (durationMs below the limit) and the terminal item states the "
      "actual byte count and sha256 of what was sent.",
      [s2c(mic(1, credit=16, max_duration_ms=60000)),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(progress(1, "running")),
       c2s(blob_start(1, 0, None, ct="audio/L16")),
       frame("c2s", 1, 0, 0, AUDIO[:16]),
       c2s(control(1, {"paused": True})),
       s2c(control(1, {"grant": 64})),
       c2s(control(1, {"paused": False})),
       frame("c2s", 1, 0, 1, AUDIO[16:]),
       frame("c2s", 1, 0, 2, AUDIO[:8]),
       c2s(result(1, {"durationMs": 1250, "item": item(0, AUDIO + AUDIO[:8], ct="audio/L16")}))])

# ------------------------------------------------------------------- round 3 capabilities
write("camera-capture-photo",
      "camera.capture@1 photo: the host's own capture UI (live preview, Capture / Cancel) is the "
      "per-use consent gate, reported as pendingConsent while it is open; the lease runs meanwhile. "
      "The captured JPEG is an existing file, so blobStart declares its exact size; exactly one item "
      "on channel 0, verified (count, contentType, bytes, sha256) before the handler sees it.",
      [s2c(cam(1, "photo", facing="back")),
       c2s(progress(1, "pendingConsent")),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(progress(1, "running")),
       c2s(blob_start(1, 0, JPEG, ct="image/jpeg")),
       frame("c2s", 1, 0, 0, JPEG),
       c2s(result(1, {"items": [item(0, JPEG, ct="image/jpeg")]}))])

write("camera-capture-video-undeclared",
      "camera.capture@1 video with a maxDurationMs recording limit: a recording's size is unknown "
      "until it ends, so blobStart omits `bytes` and the encoder output streams under credit "
      "(overflow pause: the sender reports paused, waits for a grant, resumes). The user presses Stop "
      "before the limit; the single terminal item states the actual byte count and sha256.",
      [s2c(cam(1, "video", credit=16, facing="front", max_duration_ms=15000)),
       c2s(progress(1, "pendingConsent")),
       c2s(progress(1, "running")),
       c2s(blob_start(1, 0, None, ct="video/webm")),
       frame("c2s", 1, 0, 0, WEBM[:16]),
       c2s(control(1, {"paused": True})),
       s2c(control(1, {"grant": 64})),
       c2s(control(1, {"paused": False})),
       frame("c2s", 1, 0, 1, WEBM[16:]),
       c2s(result(1, {"items": [item(0, WEBM, ct="video/webm")]}))])

write("camera-capture-cancelled",
      "Dismissing the host capture UI is `cancelled` (not a permission denial); a camera permission "
      "refused by the OS is `denied`. Nothing is uploaded in either case.",
      [s2c(cam(1, "photo")),
       c2s(progress(1, "pendingConsent")),
       c2s(error(1, "cancelled", "capture-dismissed")),
       s2c(cam(2, "video", max_duration_ms=5000)),
       c2s(error(2, "denied", "camera"))])

write("mic-record-stereo-early-stop",
      "mic.record@1 driver shape (C3): 48 kHz stereo (`channels: 2`) PCM16, frames of interleaved "
      "little-endian samples as captured, blobStart without `bytes`. The host's always-visible "
      "recording indicator carries Stop: pressing it ends the recording normally, so the terminal is "
      "a success with what was captured (durationMs below maxDurationMs). Credit-paced with a "
      "paused/resumed transition and lease renewals throughout.",
      [s2c(mic(1, credit=32, max_duration_ms=600000, channels=2, sample_rate=48000)),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(progress(1, "running")),
       c2s(blob_start(1, 0, None, ct="audio/L16")),
       frame("c2s", 1, 0, 0, STEREO[:32]),
       c2s(control(1, {"paused": True})),
       s2c(control(1, {"grant": 64})),
       c2s(control(1, {"paused": False})),
       frame("c2s", 1, 0, 1, STEREO[32:64]),
       s2c(control(1, {"renewLease": 2})),
       c2s(control(1, {"leaseAck": 2})),
       frame("c2s", 1, 0, 2, STEREO[64:]),
       c2s(result(1, {"durationMs": 1, "item": item(0, STEREO, ct="audio/L16")}))])

write("mic-record-throttled-when-credit-starves",
      "Overflow pause is bounded (C3): the recorder keeps capturing while paused, buffering up to a "
      "bounded window; when the server grants no credit before that window fills, the recording ends "
      "with `throttled` instead of buffering without bound. What was sent is discarded by the server "
      "with the failed request.",
      [s2c(mic(1, credit=16, channels=1)),
       c2s(progress(1, "running")),
       c2s(blob_start(1, 0, None, ct="audio/L16")),
       frame("c2s", 1, 0, 0, AUDIO[:16]),
       c2s(control(1, {"paused": True})),
       c2s(error(1, "throttled", "capture-buffer-full"))])

write("bluetooth-select-success",
      "bluetooth.select@1 (C4): the host-owned chooser lists a live BLE scan filtered by services / "
      "namePrefix; it is the per-use consent gate and the visible UI (with Cancel) while the scan "
      "runs. No data plane: the chosen device's identity is the JSON result (no GATT, no rssi).",
      [s2c(bsel(1, services=[HR_UUID], name_prefix="Polar")),
       c2s(progress(1, "pendingConsent")),
       s2c(control(1, {"renewLease": 1})),
       c2s(control(1, {"leaseAck": 1})),
       c2s(result(1, {"device": {"id": "dev-7f3a", "name": "Polar H10"}})),
       s2c(bsel(2)),
       c2s(result(2, {"device": {"id": "dev-anonymous"}}))])

write("bluetooth-select-cancel",
      "Cancelling the chooser is `cancelled`; a host without Web Bluetooth answers `unsupported` "
      "(it should not have advertised the capability; see capabilities-removal-and-readd). A server "
      "cancel while the chooser is open closes it and the late cancelled terminal is ignored.",
      [s2c(bsel(1, services=[HR_UUID])),
       c2s(progress(1, "pendingConsent")),
       c2s(error(1, "cancelled", "chooser-dismissed")),
       s2c(bsel(2, name_prefix="H")),
       c2s(progress(2, "pendingConsent")),
       s2c(control(2, {"cancel": True})),
       c2s(error(2, "cancelled"), ignored=True),
       s2c(bsel(3)),
       c2s(error(3, "unsupported", "bluetooth"))])

write("permission-query-unsupported",
      "Typed permissions (P1): every host maps the same closed enum. A host that cannot represent a "
      "permission at all answers `unsupported` with platformDetail = the permission name (here "
      "contacts on the web); representable ones answer a status, `photos` is granted on the web (the "
      "file picker needs no permission), and permission.request follows the same rule.",
      [s2c(pq(1, perm="contacts")),
       c2s(error(1, "unsupported", "contacts")),
       s2c(pq(2, perm="photos")),
       c2s(result(2, {"status": "granted"})),
       s2c(pq(3, perm="bluetooth")),
       c2s(result(3, {"status": "prompt"})),
       s2c(pr(4, perm="contacts")),
       c2s(error(4, "unsupported", "contacts")),
       s2c(pr(5, perm="location")),
       c2s(progress(5, "pendingConsent")),
       c2s(result(5, {"status": "denied"}))])

NATIVE_SAVE = bytes([0x5A]) * 100000
write("file-save-native-download",
      "Native file.save download plane (C1): initialCredit 0; the host shows its consent and the "
      "system destination picker FIRST (pendingConsent, lease live meanwhile), and only after the "
      "destination is chosen grants a bounded window (<= 256 KiB, <= maxOutstandingCredit). Frames "
      "are at most 64 KiB, never empty, seq contiguous from 0; the host streams to the destination (or "
      "a temp file) and replenishes credit as it writes, then verifies byte count and sha256 against "
      "the params before answering {bytesWritten}.",
      [s2c(fs(1, NATIVE_SAVE, name="export.bin", ct="application/octet-stream")),
       s2c(control(1, {"renewLease": 1})),
       c2s(progress(1, "pendingConsent")),
       c2s(control(1, {"leaseAck": 1})),
       c2s(progress(1, "running")),
       c2s(control(1, {"grant": 65536})),
       fill_frame("s2c", 1, 0, 0, 65536, byte=0x5A),
       c2s(control(1, {"grant": 65536})),
       fill_frame("s2c", 1, 0, 1, len(NATIVE_SAVE) - 65536, byte=0x5A),
       c2s(result(1, {"bytesWritten": len(NATIVE_SAVE)}))])

codes = ["unsupported", "unavailable", "denied", "revoked", "cancelled", "timeout", "throttled",
         "connectionLost", "invalidParams", "internal"]
steps = []
for i, code in enumerate(codes, start=1):
    steps.append(s2c(pq(i)))
    steps.append(c2s(error(i, code)))
steps += [s2c(bt(11)),
          c2s(event(11, {"device": {"id": "aa:bb", "name": "", "rssi": -60}})),
          c2s(error(11, "revoked", "")),
          s2c(pq(12)),
          c2s(error(12, "denied", "fake-host", simulated=True))]
write("terminal-errors",
      "Every closed error code as a terminal response; revoked ending a live scan stream after an event; "
      "platformDetail \"\" is present and round-trips; an error from a fake host carries simulated:true.",
      steps)

# =================================================================== negative
FIVE_TIB = 1 << 40


def upload_prefix(id=1, max_count=1, credit=65536, data=PHOTO):
    return [s2c(gp(id, max_count=max_count, credit=credit)), c2s(blob_start(id, 0, data))]


V = []  # (name, description, steps, write kwargs)


def neg(name, description, steps, **kw):
    V.append((name, description, steps, kw))


# ----- malformed: attributable (known id → reaction) and connection-level
neg("violation-cancel-false",
    "cancel is const true; {cancel:false} is malformed. The JSON is within the limits and names a live "
    "id, so the detecting client terminates that request with invalidParams (known-id invalid message).",
    [s2c(gp(1))] + bad(s2c(control(1, {"cancel": False})), "malformed"))
neg("violation-grant-zero", "grant is a positive additive integer; the client answers invalidParams.",
    [s2c(gp(1))] + bad(s2c(control(1, {"grant": 0})), "malformed"))
neg("violation-result-not-object",
    "result must be a JSON object. The malformed message is the client's terminal: the server settles "
    "locally with invalidParams and sends nothing.",
    [s2c(pq(1))] + bad(c2s(result(1, 5)), "malformed") + [c2s(progress(1, "running"), ignored=True)])
neg("violation-owner-lifetime-mismatch",
    "A connection owner with an activation lifetime: owner shape must match lifetime. The request is "
    "malformed; the client answers its (new, attributable) id with invalidParams.",
    bad(s2c(request(1, "permission.query", {"permission": "camera"}, 0, timeout=30000,
                    own={"connection": True})), "malformed"))
neg("violation-malformed-control-from-client",
    "A client control that fails the envelope schema ({grant:0}) on a live id: the detecting server "
    "sends cancel and settles the request locally with invalidParams.",
    upload_prefix() + bad(c2s(control(1, {"grant": 0})), "malformed")
    + [c2s(error(1, "cancelled"), ignored=True)])
neg("violation-json-limits-are-connection-level",
    "Text that breaks the RFC 001 §2.1 JSON limits (a duplicate key, a 1.0 number token, nesting "
    "deeper than 32) is attributable to no request: it is discarded and counted as a connection-level "
    "violation, never terminates the request its id seems to name (decision D3/D8), and the request "
    "completes normally.",
    [s2c(pq(2)),
     raw("c2s", '{"type":"deviceEvent","id":2,"id":2,"event":{"kind":"progress","state":"running"}}',
         expectViolation="malformed"),
     raw("c2s", '{"type":"deviceEvent","id":2,"event":{"kind":"progress","state":"running","n":1.0}}',
         expectViolation="malformed"),
     raw("s2c", '{"type":"deviceEvent","id":2,"control":{"renewLease":1},"x":' + "[" * 32 + "]" * 32 + "}",
         expectViolation="malformed"),
     c2s(result(2, {"status": "granted"}))])
neg("violation-bad-frame-header-is-connection-level",
    "A frame with an unknown version or nonzero flags is a connection-level violation (decision D3): "
    "discarded and counted, never terminating the request its (untrusted) header names. The upload "
    "then continues and completes with verified bytes.",
    upload_prefix()
    + bad(frame("c2s", 1, 0, 0, PHOTO, version=2), "malformed")
    + bad(frame("c2s", 1, 0, 0, PHOTO, flags=1), "malformed")
    + [frame("c2s", 1, 0, 0, PHOTO),
       c2s(result(1, {"items": [item(0, PHOTO)]}))])

# ----- invalidPayload
neg("violation-result-wrong-shape", "A file.save receipt on a gallery.pick request.",
    [s2c(gp(1))] + bad(c2s(result(1, {"bytesWritten": 3})), "invalidPayload"))
neg("violation-sha256-garbage", "sha256 must be 64 lowercase hex digits.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO, sha256="DEADBEEF")]})), "invalidPayload"))
neg("violation-blobstart-on-permission", "blobStart exists only on binaryUpload revisions.",
    [s2c(pq(1))] + bad(c2s(blob_start(1, 0, 1)), "invalidPayload"))
neg("violation-event-unknown-kind", "A misspelled event kind is not in the revision's event union.",
    [s2c(gp(1))] + bad(c2s(event(1, {"kind": "blobStrat", "channel": 0, "contentType": "a", "bytes": 1})),
                       "invalidPayload"))
neg("violation-params-max-count-zero", "gallery.pick maxCount is 1..max_items.",
    bad(s2c(gp(1, max_count=0)), "invalidPayload"))
neg("violation-oversize-declaration",
    "A 1 TiB blobStart exceeds the revision's max_item_bytes (64 MiB): rejected before allocation.",
    [s2c(gp(1))] + bad(c2s(blob_start(1, 0, FIVE_TIB)), "invalidPayload"))
neg("violation-mic-oversize-declaration",
    "Stream revisions too: a declared mic.record item above max_item_bytes is refused at blobStart.",
    [s2c(mic(1))] + bad(c2s(blob_start(1, 0, 64 * MIB + 1, ct="audio/L16")), "invalidPayload"))
neg("violation-file-save-oversize", "file.save bytes above max_item_bytes.",
    bad(s2c(request(1, "file.save", {"channel": 0, "name": "big.bin", "contentType": "application/octet-stream",
                                     "bytes": 64 * MIB + 1, "sha256": sha(b"")})), "invalidPayload"))
neg("violation-timeout-over-revision-max",
    "timeoutMs 30001 is within the envelope bound but above permission.query's max_timeout_ms (30000).",
    bad(s2c(pq(1, timeout=30001)), "invalidPayload"))
neg("violation-initial-credit-over-revision-max", "bluetooth.scan max_initial_credit is 256 events.",
    bad(s2c(bt(1, credit=257)), "invalidPayload"))
neg("violation-download-initial-credit-nonzero", "Server→client data planes require initialCredit 0.",
    bad(s2c(fs(1, SAVED, credit=1)), "invalidPayload"))
neg("violation-lifetime-not-allowed", "No gallery.pick revision allows the background lifetime.",
    bad(s2c(gp(1, own={"moduleInstanceId": "profile-7"}, lifetime="background")), "invalidPayload"))
neg("violation-capabilities-event-bad-offer", "Offers carry unique positive versions.",
    [s2c(cc(1))] + bad(c2s(event(1, {"capabilities": [{"name": "gallery.pick", "versions": [0, 0]}]})),
                       "invalidPayload"))
neg("violation-mic-max-duration-out-of-range",
    "mic.record maxDurationMs is a recording limit in 1..600000 ms.",
    bad(s2c(mic(1, max_duration_ms=600001)), "invalidPayload"))
neg("violation-progress-regression",
    "Progress never goes back: after running (or after any data) a pendingConsent event is invalid, and "
    "the server cancels the request.",
    [s2c(gp(1)),
     c2s(progress(1, "running")),
     c2s(blob_start(1, 0, PHOTO)),
     frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(progress(1, "pendingConsent")), "invalidPayload"))

# ----- unsupported
neg("violation-unknown-revision",
    "gallery.pick revision 2 is not declared, so nothing can validate it: the client refuses the request "
    "with unsupported (not invalidParams), and later messages for the id are ignored.",
    bad(s2c(gp(1, version=2)), "unsupported")
    + [s2c(control(1, {"renewLease": 1}), ignored=True)])
neg("violation-request-after-removal",
    "A replacement snapshot removed gallery.pick; a later gallery.pick request is not in the live "
    "selection and is refused with unsupported. (It may be a race rather than misbehaviour; either way "
    "it is never guessed or coerced.)",
    [s2c(cc(1, credit=2)),
     c2s(event(1, snapshot(CORE, "gallery.pick"))),
     c2s(event(1, snapshot(CORE)))]
    + bad(s2c(gp(2)), "unsupported"))
neg("violation-binary-plane-on-json-connection",
    "The handshake negotiated binary:false, so no binary-plane revision was selected (§2.2 rule c): a "
    "gallery.pick request on this connection is refused with unsupported; permission.query still works.",
    [s2c(pq(1))] + [c2s(result(1, {"status": "granted"}))] + bad(s2c(gp(2)), "unsupported"),
    ack=ack_of(CORE, "bluetooth.scan", "permission.query", "permission.request", binary=False))
neg("violation-capability-not-selected",
    "file.save was not in the negotiated selection (mixed deployment: the old client lacks it), so a "
    "file.save request is refused with unsupported.",
    bad(s2c(fs(1, SAVED)), "unsupported"),
    ack=ack_of(CORE, "gallery.pick", "permission.query"))
neg("violation-snapshot-cannot-widen-ack",
    "The negotiated ack is the ceiling for the whole connection (§2.2): live selection = ack ∩ latest "
    "snapshot. The client's hello lacked mic.record (its recording indicator was not ready yet), so the "
    "ack omits it although this server advertises it. A later snapshot lists mic.record; a snapshot can "
    "narrow the live selection or restore an entry it withdrew, never widen it, so mic.record stays "
    "unsupported until the next handshake and a mic.record request is refused with unsupported (a "
    "server broker refuses it locally). gallery.pick, withdrawn and restored within the ack, works "
    "again.",
    [s2c(cc(1)),
     c2s(event(1, snapshot(CORE, "permission.query"))),
     c2s(event(1, snapshot(CORE, "permission.query", "gallery.pick", "mic.record")))]
    + bad(s2c(mic(2)), "unsupported")
    + [s2c(gp(3)),
       c2s(error(3, "cancelled", "picker-dismissed"))],
    ack=ack_of(CORE, "gallery.pick", "permission.query"),
    server=[{"name": n, "versions": [1]}
            for n in (CORE, "gallery.pick", "mic.record", "permission.query")])

# ----- owner
neg("violation-activation-goes-backwards",
    "activationIds only increase per moduleInstanceId: after editor-1 activation 2 was swept, a request "
    "under the older activation 1 would resurrect revoked authority. The client refuses it with "
    "invalidParams.",
    [s2c(pq(1, own=owner("editor-1", 2))),
     s2c(control(1, {"cancel": True}))]
    + bad(s2c(pq(2, own=owner("editor-1", 1))), "owner"))

# ----- connection
neg("violation-request-before-core",
    "An app request before the connection-owned core.capabilities stream was opened (§2.2: the stream "
    "opens before module callbacks can request device work). The connection's mandatory control is "
    "missing: the client closes the device connection.",
    bad(s2c(gp(1)), "connection"), prelude=False)
neg("violation-two-core-streams",
    "A second core.capabilities stream while the first is live: a planned reopen retires the old stream "
    "first (core-capabilities-reopen). The broken control stream closes the device connection.",
    [s2c(cc(1, credit=1)),
     c2s(event(1, snapshot(CORE)))]
    + bad(s2c(cc(2, credit=1)), "connection"))
neg("violation-core-stream-terminal-closes-connection",
    "An unexpected terminal of the live core.capabilities stream (not preceded by the server's cancel) "
    "closes the device connection; no further device traffic is defined.",
    [s2c(cc(1)),
     c2s(event(1, snapshot(CORE)))]
    + bad(c2s(result(1, {})), "connection"))

# ----- direction
neg("violation-request-from-client",
    "Only the server sends deviceRequest. A client deviceRequest reusing a live server id is a known-id "
    "wrong-direction message: the server cancels request 1 and settles it with invalidParams. (A client "
    "request for a non-live id is simply ignored: unknown-ids-ignored-in-any-direction.)",
    [s2c(pq(1))] + bad(c2s(pq(1)), "direction"))
neg("violation-response-from-server",
    "Only the client sends deviceResponse. A server deviceResponse on a live id makes the client "
    "terminate that operation with invalidParams (decision D8); later messages for the id are ignored.",
    [s2c(pq(1))] + bad(s2c(result(1, {"status": "granted"})), "direction")
    + [c2s(result(1, {"status": "granted"}), ignored=True),
       s2c(control(1, {"renewLease": 1}), ignored=True)])
neg("violation-event-from-server", "Capability events flow client → server.",
    [s2c(pq(1))] + bad(s2c(progress(1, "running")), "direction"))
neg("violation-renew-lease-from-client", "renewLease is server → client.",
    [s2c(bt(1))] + bad(c2s(control(1, {"renewLease": 1})), "direction"))
neg("violation-lease-ack-from-server", "leaseAck is client → server.",
    [s2c(bt(1)), s2c(control(1, {"renewLease": 1}))] + bad(s2c(control(1, {"leaseAck": 1})), "direction"))
neg("violation-cancel-from-client",
    "cancel is server → client; client cancellation is a terminal cancelled response. The server cancels "
    "the request in return and ignores the client's late cancelled terminal.",
    [s2c(pq(1))] + bad(c2s(control(1, {"cancel": True})), "direction")
    + [c2s(error(1, "cancelled"), ignored=True)])
neg("violation-grant-from-download-sender", "On file.save the server sends data; only the client (receiver) grants.",
    [s2c(fs(1, SAVED))] + bad(s2c(control(1, {"grant": 64})), "direction"))
neg("violation-grant-from-upload-sender", "On gallery.pick the client sends data; only the server (receiver) grants.",
    [s2c(gp(1))] + bad(c2s(control(1, {"grant": 64})), "direction"))
neg("violation-frame-against-download-direction", "file.save frames flow server → client.",
    [s2c(fs(1, SAVED)), c2s(control(1, {"grant": 64}))] + bad(frame("c2s", 1, 0, 0, SAVED), "direction"))
neg("violation-frame-against-upload-direction", "gallery.pick frames flow client → server.",
    [s2c(gp(1))] + bad(frame("s2c", 1, 0, 0, PHOTO), "direction"))
neg("violation-frame-on-json-plane", "bluetooth.scan has no binary data plane.",
    [s2c(bt(1))] + bad(frame("c2s", 1, 0, 0, b"x"), "direction"))
neg("violation-paused-from-receiver", "paused is reported by the data sender.",
    [s2c(gp(1))] + bad(s2c(control(1, {"paused": True})), "direction"))

# ----- credit
neg("violation-data-exceeds-credit", "17 bytes against 4 bytes of credit.",
    upload_prefix(credit=4) + bad(frame("c2s", 1, 0, 0, PHOTO), "credit"))
neg("violation-grant-exceeds-max-outstanding",
    "4 MiB initial + 4 MiB + 1 granted exceeds max_outstanding_credit (8 MiB).",
    [s2c(gp(1, credit=4 * MIB))] + bad(s2c(control(1, {"grant": 4 * MIB + 1})), "credit"))
neg("violation-json-events-exceed-credit", "JSON stream credit counts events: one credit, two scan events.",
    [s2c(bt(1, credit=1)),
     c2s(event(1, {"device": {"id": "a", "rssi": -1}}))]
    + bad(c2s(event(1, {"device": {"id": "b", "rssi": -2}})), "credit"))
neg("violation-grant-without-data-plane", "permission.query has no data plane to grant credit for.",
    [s2c(pq(1))] + bad(s2c(control(1, {"grant": 1})), "credit"))
neg("violation-paused-repeated", "paused reports transitions, not repeated notifications.",
    [s2c(gp(1)), c2s(control(1, {"paused": True}))] + bad(c2s(control(1, {"paused": True})), "credit"))
neg("violation-data-while-paused",
    "A sender that reported paused:true sends no data until it reports paused:false.",
    upload_prefix() + [c2s(control(1, {"paused": True}))] + bad(frame("c2s", 1, 0, 0, PHOTO), "credit"))

# ----- lease
neg("violation-lease-ack-future", "Acknowledging a sequence the server never sent is invalid.",
    [s2c(bt(1)), s2c(control(1, {"renewLease": 1}))] + bad(c2s(control(1, {"leaseAck": 2})), "lease"))
neg("violation-lease-ack-before-renewal", "No renewal was sent: any leaseAck is fabricated.",
    [s2c(bt(1))] + bad(c2s(control(1, {"leaseAck": 1})), "lease"))
neg("violation-lease-ack-cross-request",
    "Lease sequences are per request: renewal 1 was sent on request 1, so a leaseAck 1 on request 2 is "
    "fabricated for request 2.",
    [s2c(bt(1)), s2c(bt(2)), s2c(control(1, {"renewLease": 1}))] + bad(c2s(control(2, {"leaseAck": 1})), "lease"))
neg("violation-renew-lease-not-increasing", "Renewal sequences strictly increase.",
    [s2c(bt(1)), s2c(control(1, {"renewLease": 1}))] + bad(s2c(control(1, {"renewLease": 1})), "lease"))
neg("violation-renew-lease-not-starting-at-1",
    "The server's first renewal on a request is sequence 1 (§2.7); starting at 4294967295 would also "
    "leave no room to renew.",
    [s2c(bt(1))] + bad(s2c(control(1, {"renewLease": U32_MAX})), "lease"))

# ----- sequence
neg("violation-seq-gap", "A lossless (pause) channel requires contiguous seq.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO[:6])] + bad(frame("c2s", 1, 0, 2, PHOTO[6:]), "sequence"))
neg("violation-seq-repeat", "Repeated seq is invalid.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO[:6])] + bad(frame("c2s", 1, 0, 0, PHOTO[6:]), "sequence"))
neg("violation-seq-not-starting-at-zero", "seq starts at zero per (requestId, channel).",
    upload_prefix() + bad(frame("c2s", 1, 0, 1, PHOTO), "sequence"))

# ----- blob
neg("violation-frame-before-blobstart", "Announcement before bytes.",
    [s2c(gp(1))] + bad(frame("c2s", 1, 0, 0, PHOTO), "blob"))
neg("violation-frame-unannounced-channel", "Bytes on channel 1 when only channel 0 was announced.",
    upload_prefix(max_count=2) + bad(frame("c2s", 1, 1, 0, PHOTO), "blob"))
neg("violation-duplicate-blobstart-channel", "Channels are unique within a request.",
    upload_prefix(max_count=2) + bad(c2s(blob_start(1, 0, PHOTO)), "blob"))
neg("violation-blobstart-exceeds-max-count", "maxCount 1 allows channel 0 only.",
    upload_prefix(max_count=1) + bad(c2s(blob_start(1, 1, PHOTO)), "blob"))
neg("violation-bytes-exceed-declaration", "17 bytes against a 5-byte declaration.",
    upload_prefix(data=5) + bad(frame("c2s", 1, 0, 0, PHOTO), "blob"))
neg("violation-mic-declared-size-exceeded",
    "Stream revisions too: bytes beyond a declared mic.record item size terminate the request.",
    [s2c(mic(1, credit=64)), c2s(blob_start(1, 0, 16, ct="audio/L16"))]
    + bad(frame("c2s", 1, 0, 0, AUDIO), "blob"))
neg("violation-mic-declared-size-not-reached",
    "A declared size that is not reached when the stream ends is invalid: the terminal item must equal "
    "the declaration and the received bytes.",
    [s2c(mic(1, credit=64)), c2s(blob_start(1, 0, AUDIO, ct="audio/L16")), frame("c2s", 1, 0, 0, AUDIO[:16])]
    + bad(c2s(result(1, {"durationMs": 500, "item": item(0, AUDIO[:16], ct="audio/L16")})), "blob"))
neg("violation-undeclared-result-bytes-mismatch",
    "Without a declaration the terminal item still states the actual size: it must equal the bytes "
    "received (17), not 999.",
    [s2c(gp(1)), c2s(blob_start(1, 0, None)), frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO, nbytes=999)]})), "blob"))
neg("violation-oversize-chunk", "A 65537-byte frame payload exceeds the 64 KiB chunk bound.",
    upload_prefix(data=70000) + bad(fill_frame("c2s", 1, 0, 0, 65537), "blob"))
neg("violation-empty-frame",
    "A zero-length payload frame is always a violation (decision D2): it carries no data, consumes no "
    "credit and would let a sender make the receiver process unbounded frames.",
    upload_prefix(credit=0) + bad(frame("c2s", 1, 0, 0, b""), "blob"))
neg("violation-empty-frame-for-empty-item",
    "A zero-byte item sends no frames; not even one empty frame at seq 0.",
    [s2c(gp(1)), c2s(blob_start(1, 0, EMPTY, ct="text/plain"))] + bad(frame("c2s", 1, 0, 0, b""), "blob"))
neg("violation-empty-download-frame",
    "Downloads too: an empty server→client frame is a violation the client answers with invalidParams.",
    [s2c(fs(1, SAVED)), c2s(control(1, {"grant": 64}))] + bad(frame("s2c", 1, 0, 0, b""), "blob"))
neg("violation-terminal-before-last-chunk", "Terminal success after 6 of 17 announced bytes.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO[:6])]
    + bad(c2s(result(1, {"items": [item(0, PHOTO)]})), "blob"))
neg("violation-sha256-mismatch", "Declared hash does not match the received bytes.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO, sha256=sha(b"other"))]})), "blob"))
neg("violation-result-channel-mismatch", "Result reports channel 3; channel 0 was announced.",
    upload_prefix(max_count=4) + [frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(3, PHOTO)]})), "blob"))
neg("violation-result-bytes-mismatch", "Result reports 999 bytes; 17 were announced and received.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO, nbytes=999)]})), "blob"))
neg("violation-result-content-type-mismatch", "Result metadata differs from the announcement.",
    upload_prefix() + [frame("c2s", 1, 0, 0, PHOTO)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO, ct="image/png")]})), "blob"))
neg("violation-result-missing-announced-item", "Two items announced, one reported.",
    [s2c(gp(1, max_count=2)), c2s(blob_start(1, 0, PHOTO)), c2s(blob_start(1, 1, SECOND)),
     frame("c2s", 1, 0, 0, PHOTO), frame("c2s", 1, 1, 0, SECOND)]
    + bad(c2s(result(1, {"items": [item(0, PHOTO)]})), "blob"))
neg("violation-download-hash-mismatch",
    "The client reports success although the bytes do not match the declared sha256.",
    [s2c(fs(1, SAVED)), c2s(control(1, {"grant": 64})), frame("s2c", 1, 0, 0, b"hypen-SAVED")]
    + bad(c2s(result(1, {"bytesWritten": 11})), "blob"))
neg("violation-download-short", "The client reports success before the declared byte count arrived.",
    [s2c(fs(1, SAVED)), c2s(control(1, {"grant": 64})), frame("s2c", 1, 0, 0, SAVED[:5])]
    + bad(c2s(result(1, {"bytesWritten": 11})), "blob"))


def over_limit_steps(req, ct, max_outstanding, initial_credit):
    """Stream an undeclared item past max_item_bytes (64 MiB) in 64 KiB fill frames under credit."""
    steps = [s2c(req), c2s(blob_start(1, 0, None, ct=ct))]
    credit, sent, seq = initial_credit, 0, 0
    limit = 64 * MIB
    while sent < limit:
        if credit < CHUNK:
            grant = max_outstanding - credit
            steps.append(s2c(control(1, {"grant": grant})))
            credit += grant
        steps.append(fill_frame("c2s", 1, 0, seq, CHUNK))
        credit -= CHUNK
        sent += CHUNK
        seq += 1
    if credit < 1:
        steps.append(s2c(control(1, {"grant": CHUNK})))
    return steps + bad(frame("c2s", 1, 0, seq, b"\x00"), "blob")


neg("violation-undeclared-over-max-item-bytes",
    "An undeclared item is bounded as bytes arrive (decision D5): the 64 MiB + 1st byte of a gallery.pick "
    "item exceeds max_item_bytes, and the server cancels (invalidParams) without buffering further.",
    over_limit_steps(gp(1, credit=4 * MIB), "image/jpeg", 8 * MIB, 4 * MIB), compact=True)
neg("violation-mic-undeclared-over-max-item-bytes",
    "Stream revisions too: a live mic.record item without a declaration is cut off by max_item_bytes "
    "(64 MiB) as bytes arrive; a recording limit is maxDurationMs, never a size.",
    over_limit_steps(mic(1, credit=256 * KIB, max_duration_ms=600000), "audio/L16", MIB, 256 * KIB),
    compact=True)

# ----- round 3 capabilities
neg("violation-permission-unknown-name",
    "Typed permissions (P1): a permission outside the closed enum (a typo, the old \"geolocation\" "
    "alias) fails the revision's params schema; the client refuses it with invalidParams before "
    "touching any platform API, and the connection carries on.",
    bad(s2c(pq(1, perm="camra")), "invalidPayload")
    + bad(s2c(pr(2, perm="geolocation")), "invalidPayload")
    + [s2c(pq(3, perm="camera")), c2s(result(3, {"status": "prompt"}))])
neg("violation-camera-photo-max-duration",
    "camera.capture@1: maxDurationMs is a video-only recording limit; on a photo request it is "
    "invalidParams.",
    bad(s2c(cam(1, "photo", max_duration_ms=5000)), "invalidPayload"))
neg("violation-camera-second-item",
    "camera.capture@1 returns exactly one item (maxItems 1): a blobStart on channel 1 is outside "
    "the revision's channel range, and the server cancels.",
    [s2c(cam(1, "photo")), c2s(blob_start(1, 0, JPEG, ct="image/jpeg"))]
    + bad(c2s(blob_start(1, 1, None, ct="image/jpeg")), "invalidPayload")
    + [c2s(error(1, "cancelled"), ignored=True)])
neg("violation-camera-result-two-items",
    "A camera.capture@1 success with two items fails the result schema (exactly one item): the "
    "server settles locally with invalidParams (the offending message is the client's terminal).",
    [s2c(cam(1, "photo")),
     c2s(blob_start(1, 0, JPEG, ct="image/jpeg")),
     frame("c2s", 1, 0, 0, JPEG)]
    + bad(c2s(result(1, {"items": [item(0, JPEG, ct="image/jpeg"), item(1, JPEG, ct="image/jpeg")]})),
          "invalidPayload"))
neg("violation-camera-content-type-does-not-fit-mode",
    "camera.capture@1 metadata must fit the request (RFC 001 §2.4 disallowed metadata): a photo "
    "request announcing a video/mp4 item is a blob violation, and a content type outside the "
    "camera set (image/png) fails the event schema.",
    [s2c(cam(1, "photo"))]
    + bad(c2s(blob_start(1, 0, None, ct="video/mp4")), "blob")
    + [s2c(cam(2, "video"))]
    + bad(c2s(blob_start(2, 0, None, ct="image/png")), "invalidPayload"))
neg("violation-bluetooth-select-bad-service-uuid",
    "bluetooth.select@1 service UUIDs use the canonical lowercase 128-bit form; the 16-bit short "
    "form \"0x180d\" must be sent expanded (0000180d-0000-1000-8000-00805f9b34fb).",
    bad(s2c(bsel(1, services=["0x180d"])), "invalidPayload")
    + [s2c(bsel(2, services=[HR_UUID])), c2s(result(2, {"device": {"id": "dev-1"}}))])
neg("violation-bluetooth-select-grant",
    "bluetooth.select@1 has no data plane: a server grant on it is a credit violation the client "
    "answers with invalidParams.",
    [s2c(bsel(1))] + bad(s2c(control(1, {"grant": 1})), "credit"))
neg("violation-mic-channels-out-of-range",
    "mic.record@1 `channels` is 1 or 2.",
    bad(s2c(mic(1, channels=3)), "invalidPayload"))

for name, description, steps, kw in V:
    assert name.startswith("violation-"), name
    write(name, description, steps, **kw)

# Remove stale outputs: this script owns the directory.
removed = 0
for f in os.listdir(ROOT):
    if f.endswith(".json") and f[:-5] not in WRITTEN:
        os.remove(os.path.join(ROOT, f))
        removed += 1

print("wrote", len(WRITTEN), "transcripts;", len(V), "violation transcripts; removed", removed, "stale")
