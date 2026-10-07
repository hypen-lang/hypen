#!/usr/bin/env python3
"""Generates engine-compatibility-tests/fixtures/device/conformance/*.json."""
import copy
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "conformance")
os.makedirs(ROOT, exist_ok=True)

DROP = object()
SHA = "5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347"
MIB = 1024 * 1024
ASTRAL = "\U0001F600"  # 1 code point, 2 UTF-16 units, 4 UTF-8 bytes


def with_(base, **over):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if v is DROP:
            out.pop(k, None)
        else:
            out[k] = v
    return out


REQ = {
    "type": "deviceRequest", "id": 17, "capability": "gallery.pick", "version": 1,
    "owner": {"moduleInstanceId": "profile-7", "activationId": 3},
    "lifetime": "activation", "timeoutMs": 300000, "initialCredit": 65536,
    "params": {"mediaTypes": ["photo"], "maxCount": 1},
}
RES = {"type": "deviceResponse", "id": 17, "result": {"items": []}}
ERR = {"type": "deviceResponse", "id": 17, "error": {"code": "denied", "platformDetail": "user-declined"}}
EV = {"type": "deviceEvent", "id": 17,
      "event": {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 120000}}


def ctl(c, id=17):
    return {"type": "deviceEvent", "id": id, "control": c}


def owner(o, lifetime="activation"):
    return with_(REQ, owner=o, lifetime=lifetime)


valid = []
invalid = []


def V(name, message):
    valid.append({"name": name, "message": message})


def X(name, message, reason, beyond_schema=False):
    case = {"name": name, "message": message, "reason": reason}
    if beyond_schema:
        case["beyondSchema"] = True
    invalid.append(case)


def RAW(name, raw, reason, json_text=True):
    if json_text:
        json.loads(raw)  # JSON text (duplicates collapse silently here)
    invalid.append({"name": name, "raw": raw, "reason": reason})


def RAW_HEX(name, data, reason):
    """Bytes a JSON string cannot carry (invalid UTF-8): hex of the exact text bytes."""
    invalid.append({"name": name, "rawHex": data.hex(), "reason": reason})


def RAW_REPEAT(name, prefix, repeat, count, suffix, reason=None):
    """text = prefix + repeat * count + suffix (keeps multi-megabyte cases small)."""
    case = {"name": name, "rawRepeat": {"prefix": prefix, "repeat": repeat, "count": count, "suffix": suffix}}
    if reason is None:
        valid.append(case)
    else:
        case["reason"] = reason
        invalid.append(case)


def VRAW(name, raw):
    """A valid case given as exact text (escapes, whitespace, boundary numbers)."""
    json.loads(raw)
    valid.append({"name": name, "raw": raw})


MSG_MAX = 1048576
SAFE = 9007199254740991


def ev_text(inner, id=1):
    return '{"type":"deviceEvent","id":%d,"event":%s}' % (id, inner)


def nest(n):
    return "[" * n + "]" * n


# ---------------------------------------------------------------- valid
V("request-rfc-example", REQ)
V("request-connection-owner", with_(REQ, id=1, capability="core.capabilities",
                                    owner={"connection": True}, lifetime="connection",
                                    timeoutMs=86400000, initialCredit=8, params={}))
V("request-background-owner", owner({"moduleInstanceId": "recorder-2"}, "background"))
V("request-max-bounds", with_(REQ, id=4294967295, version=4294967295, timeoutMs=86400000,
                              initialCredit=4 * MIB,
                              owner={"moduleInstanceId": "m", "activationId": 4294967295}))
V("request-min-bounds", with_(REQ, id=1, timeoutMs=1, initialCredit=0))
V("request-capability-name-128", with_(REQ, capability="c" * 128))
V("request-capability-name-1", with_(REQ, capability="c"))
V("request-module-instance-id-256-astral-code-points",
  owner({"moduleInstanceId": ASTRAL * 256, "activationId": 1}))
V("request-module-instance-id-1", owner({"moduleInstanceId": "x", "activationId": 1}))
V("request-params-empty-object", with_(REQ, params={}))
V("request-params-opaque-nested-object", with_(REQ, params={"a": {"b": [1, {"c": None}]}}))
V("response-result", with_(RES, result={"items": [
    {"channel": 0, "contentType": "image/jpeg", "bytes": 17, "sha256": SHA}]}))
V("response-result-empty-object", with_(RES, result={}))
V("response-error-with-detail", ERR)
V("response-error-without-detail", with_(ERR, error={"code": "denied"}))
V("response-error-platform-detail-empty-string-is-present",
  with_(ERR, error={"code": "internal", "platformDetail": ""}))
V("response-error-platform-detail-512-astral-code-points",
  with_(ERR, error={"code": "internal", "platformDetail": ASTRAL * 512}))
V("response-simulated-result", with_(RES, simulated=True))
V("response-simulated-error", with_(ERR, simulated=True))
for code in ["unsupported", "unavailable", "denied", "revoked", "cancelled", "timeout",
             "throttled", "connectionLost", "invalidParams", "internal"]:
    V(f"response-error-code-{code}", with_(ERR, error={"code": code}))
V("event-blob-start", EV)
V("event-progress", with_(EV, event={"kind": "progress", "state": "pendingConsent"}))
V("event-empty-object", with_(EV, event={}))
V("control-grant-1", ctl({"grant": 1}))
V("control-grant-max-outstanding", ctl({"grant": 8 * MIB}))
V("control-cancel", ctl({"cancel": True}))
V("control-renew-lease-1", ctl({"renewLease": 1}))
V("control-renew-lease-u32-max", ctl({"renewLease": 4294967295}))
V("control-lease-ack-1", ctl({"leaseAck": 1}))
V("control-lease-ack-u32-max", ctl({"leaseAck": 4294967295}))
V("control-paused-true", ctl({"paused": True}))
V("control-paused-false", ctl({"paused": False}))
V("id-max-u32", ctl({"cancel": True}, id=4294967295))
V("event-opaque-integer-2^53-minus-1", with_(EV, event={"a": SAFE, "b": -SAFE}))
V("event-opaque-depth-32",
  with_(EV, event={"a": json.loads(nest(30))}))  # envelope 1 + event 2 + 30 arrays = 32
VRAW("raw-escapes-and-surrogate-pair",
     ev_text(r'{"a":"\ud83d\ude00 \u00e9 \/ \b\f\n\r\t \\ \"","\u0062":1}'))
VRAW("raw-json-whitespace", ' \t\r\n{ "type" : "deviceEvent" ,\n"id":1 ,"control":{"cancel":true} } \n')
VRAW("raw-depth-32", ev_text('{"a":%s}' % nest(30)))
VRAW("raw-integer-bounds", ev_text('{"a":9007199254740991,"b":-9007199254740991,"c":0}'))
_head = '{"type":"deviceEvent","id":1,"control":{"cancel":true}'
RAW_REPEAT("raw-message-exactly-1-mib", _head, " ", MSG_MAX - len(_head) - 1, "}")

# Round 3: envelopes carrying the new capability revisions (params stay opaque to the
# envelope; payloads.json pins them against the revision schemas).
V("request-camera-capture-video", with_(REQ, capability="camera.capture", timeoutMs=600000,
                                        initialCredit=4 * MIB,
                                        params={"mode": "video", "facing": "back", "maxDurationMs": 15000}))
V("request-bluetooth-select", with_(REQ, capability="bluetooth.select", initialCredit=0,
                                    params={"services": ["0000180d-0000-1000-8000-00805f9b34fb"],
                                            "namePrefix": "Polar"}))
V("request-mic-record-stereo", with_(REQ, capability="mic.record", timeoutMs=600000, initialCredit=262144,
                                     params={"sampleRate": 48000, "format": "pcm16", "channels": 2}))
V("request-permission-query-typed", with_(REQ, capability="permission.query", timeoutMs=30000,
                                          initialCredit=0, params={"permission": "contacts"}))
V("response-bluetooth-select-device", with_(RES, result={"device": {"id": "dev-1", "name": "Polar H10"}}))
V("response-permission-unsupported-names-the-permission",
  with_(ERR, error={"code": "unsupported", "platformDetail": "contacts"}))
V("event-camera-blob-start-undeclared", with_(EV, event={"kind": "blobStart", "channel": 0,
                                                         "contentType": "video/webm"}))

# ---------------------------------------------------------------- invalid: request
for field in ["id", "capability", "version", "owner", "lifetime", "timeoutMs",
              "initialCredit", "params"]:
    X(f"request-missing-{field}", with_(REQ, **{field: DROP}), f"required member {field} missing")
for field in ["id", "capability", "version", "owner", "lifetime", "timeoutMs",
              "initialCredit", "params"]:
    X(f"request-null-{field}", with_(REQ, **{field: None}), f"null for required {field}")
X("request-missing-type", with_(REQ, type=DROP), "type discriminator missing")
X("request-unknown-type", with_(REQ, type="deviceBogus"), "unknown message type")
X("request-type-wrong-case", with_(REQ, type="DeviceRequest"), "type values are exact-case")
X("request-key-wrong-case-ID", with_(REQ, id=DROP, ID=17), "keys are exact-case: ID is unknown and id missing")
X("request-key-wrong-case-Capability", with_(REQ, capability=DROP, Capability="gallery.pick"), "keys are exact-case")
X("request-extra-key", with_(REQ, extra=1), "closed object")
X("request-id-zero", with_(REQ, id=0), "id 0 is reserved")
X("request-id-2^32", with_(REQ, id=4294967296), "id is a u32")
X("request-id-negative", with_(REQ, id=-1), "id is a u32")
X("request-id-string", with_(REQ, id="17"), "id is an integer")
X("request-id-fraction", with_(REQ, id=17.5), "id is an integer")
X("request-version-zero", with_(REQ, version=0), "version 0 is reserved")
X("request-timeout-zero", with_(REQ, timeoutMs=0), "timeoutMs is positive")
X("request-timeout-over-registry-max", with_(REQ, timeoutMs=86400001), "timeoutMs above the largest registry max_timeout_ms")
X("request-initial-credit-over-registry-max", with_(REQ, initialCredit=4 * MIB + 1), "initialCredit above the largest registry max_initial_credit")
X("request-initial-credit-negative", with_(REQ, initialCredit=-1), "initialCredit is unsigned")
X("request-params-number", with_(REQ, params=5), "params must be an object")
X("request-params-array", with_(REQ, params=[]), "params must be an object")
X("request-lifetime-unknown", with_(REQ, lifetime="forever"), "closed lifetime enum")
X("request-capability-empty", with_(REQ, capability=""), "capability name is 1..128 code points")
X("request-capability-129", with_(REQ, capability="c" * 129), "capability name is 1..128 code points")
X("request-owner-activation-id-negative", owner({"moduleInstanceId": "x", "activationId": -1}),
  "malformed activation owner is rejected, never downgraded to a module owner")
X("request-owner-activation-id-string", owner({"moduleInstanceId": "x", "activationId": "3"}),
  "malformed activation owner is rejected, never downgraded to a module owner")
X("request-owner-activation-id-zero", owner({"moduleInstanceId": "x", "activationId": 0}), "activationId >= 1")
X("request-owner-activation-id-2^32", owner({"moduleInstanceId": "x", "activationId": 4294967296}), "activationId is a u32")
X("request-owner-activation-id-null", owner({"moduleInstanceId": "x", "activationId": None}), "null activationId")
X("request-owner-connection-false", owner({"connection": False}, "connection"), "connection is const true")
X("request-owner-connection-null", owner({"connection": None}, "connection"), "connection is const true")
X("request-owner-module-plus-connection", owner({"moduleInstanceId": "x", "connection": True}, "background"),
  "owner is exactly one shape; no mixing")
X("request-owner-activation-null-sibling", owner({"moduleInstanceId": "x", "activationId": 1, "connection": None}),
  "a null sibling is still a present key")
X("request-owner-extra-key", owner({"moduleInstanceId": "x", "activationId": 1, "extra": 1}), "closed owner object")
X("request-owner-wrong-case", owner({"ModuleInstanceId": "x", "activationId": 1}), "keys are exact-case")
X("request-owner-empty", owner({}), "owner must have one of the three shapes")
X("request-owner-module-instance-id-empty", owner({"moduleInstanceId": "", "activationId": 1}), "moduleInstanceId is 1..256 code points")
X("request-owner-module-instance-id-257", owner({"moduleInstanceId": "m" * 257, "activationId": 1}), "moduleInstanceId is 1..256 code points")
X("request-owner-module-instance-id-257-astral", owner({"moduleInstanceId": ASTRAL * 257, "activationId": 1}),
  "maxLength counts code points: 257 > 256")
X("request-owner-activation-with-background-lifetime", owner({"moduleInstanceId": "x", "activationId": 1}, "background"),
  "owner shape must match lifetime", beyond_schema=True)
X("request-owner-module-with-activation-lifetime", owner({"moduleInstanceId": "x"}, "activation"),
  "owner shape must match lifetime (no silent downgrade)", beyond_schema=True)
X("request-owner-connection-with-activation-lifetime", owner({"connection": True}, "activation"),
  "owner shape must match lifetime", beyond_schema=True)

X("request-camera-capture-params-array", with_(REQ, capability="camera.capture", params=["photo"]),
  "params must be an object (an array never stands in for an object)")
X("request-permission-query-params-string", with_(REQ, capability="permission.query", params="camera"),
  "params must be an object, not the bare permission name")

# ---------------------------------------------------------------- invalid: response
X("response-both-result-and-error", with_(RES, error={"code": "denied"}), "terminal XOR")
X("response-neither-result-nor-error", with_(RES, result=DROP), "terminal XOR")
X("response-result-null-with-error", with_(ERR, result=None), "a null result is present, and not an object")
X("response-error-null-with-result", with_(RES, error=None), "a null error is present, and not an error object")
X("response-simulated-false", with_(RES, simulated=False), "simulated is const true when present")
X("response-simulated-null", with_(RES, simulated=None), "simulated is const true when present")
X("response-result-number", with_(RES, result=5), "result must be an object")
X("response-result-array", with_(RES, result=[]), "result must be an object")
X("response-result-string", with_(RES, result="x"), "result must be an object")
X("response-error-unknown-code", with_(ERR, error={"code": "nuked"}), "closed error code enum")
X("response-error-code-wrong-case", with_(ERR, error={"code": "Denied"}), "closed error code enum")
X("response-error-platform-detail-null", with_(ERR, error={"code": "denied", "platformDetail": None}),
  "platformDetail is a string when present")
X("response-error-platform-detail-513", with_(ERR, error={"code": "denied", "platformDetail": "d" * 513}),
  "platformDetail is at most 512 code points")
X("response-error-platform-detail-513-astral", with_(ERR, error={"code": "denied", "platformDetail": ASTRAL * 513}),
  "maxLength counts code points: 513 > 512")
X("response-error-extra-key", with_(ERR, error={"code": "denied", "extra": 1}), "closed error object")
X("response-error-wrong-case-key", with_(ERR, error={"Code": "denied"}), "keys are exact-case")
X("response-extra-key", with_(RES, extra=1), "closed object")
X("response-id-zero", with_(RES, id=0), "id 0 is reserved")
X("response-id-2^32", with_(RES, id=4294967296), "id is a u32")
X("response-missing-id", with_(RES, id=DROP), "required member id missing")

# ---------------------------------------------------------------- invalid: event / control
X("event-both-event-and-control", with_(EV, control={"cancel": True}), "event XOR control")
X("event-neither-event-nor-control", with_(EV, event=DROP), "event XOR control")
X("event-null-event-with-control", with_(ctl({"cancel": True}), event=None), "a null event is present, and not an object")
X("event-null-control-with-event", with_(EV, control=None), "a null control is present, and not a control")
X("event-array", with_(EV, event=[]), "event must be an object")
X("event-string", with_(EV, event="x"), "event must be an object")
X("event-id-zero", with_(EV, id=0), "id 0 is reserved")
X("event-extra-key", with_(EV, extra=1), "closed object")
X("control-cancel-false", ctl({"cancel": False}), "cancel is const true")
X("control-cancel-null", ctl({"cancel": None}), "cancel is const true")
X("control-grant-zero", ctl({"grant": 0}), "grant is positive")
X("control-grant-negative", ctl({"grant": -1}), "grant is positive")
X("control-grant-string", ctl({"grant": "5"}), "grant is an integer")
X("control-grant-over-registry-max", ctl({"grant": 8 * MIB + 1}), "grant above the largest registry max_outstanding_credit")
X("control-renew-lease-zero", ctl({"renewLease": 0}), "lease sequences start at 1")
X("control-renew-lease-2^32", ctl({"renewLease": 4294967296}), "lease sequences are u32")
X("control-renew-lease-json-safe-max", ctl({"renewLease": 9007199254740991}), "lease sequences are u32, not JSON-safe integers")
X("control-lease-ack-2^32", ctl({"leaseAck": 4294967296}), "lease sequences are u32")
X("control-lease-ack-zero", ctl({"leaseAck": 0}), "lease sequences start at 1")
X("control-paused-null", ctl({"paused": None}), "paused is a boolean")
X("control-paused-string", ctl({"paused": "true"}), "paused is a boolean")
X("control-two-keys", ctl({"grant": 5, "cancel": True}), "exactly one control variant")
X("control-null-sibling", ctl({"grant": 5, "cancel": None}), "a null sibling is still a second variant")
X("control-empty", ctl({}), "exactly one control variant")
X("control-unknown-variant", ctl({"nuke": True}), "closed control variants")
X("control-wrong-case", ctl({"Grant": 5}), "keys are exact-case")

# ---------------------------------------------------------------- invalid: arrays for objects, maps for enums
X("response-error-as-array", with_(ERR, error=["denied"]), "an array never stands in for the error object")
X("response-error-as-array-with-detail", with_(ERR, error=["denied", "detail"]), "an array never stands in for the error object")
X("response-error-code-as-map", with_(ERR, error={"code": {"denied": None}}), "a one-key map never stands in for an enum string")
X("request-lifetime-as-map", with_(REQ, lifetime={"activation": None}), "a one-key map never stands in for an enum string")
X("request-owner-as-array", with_(REQ, owner=["profile-7", 3]), "an array never stands in for the owner object")
X("control-as-array", ctl([65536]), "an array never stands in for the control object")
X("control-grant-as-array", ctl({"grant": [1]}), "grant is an integer")
X("request-type-as-map", with_(REQ, type={"deviceRequest": None}), "type is a string")

# ---------------------------------------------------------------- invalid: raw JSON text
RAW("raw-duplicate-id",
    '{"type":"deviceEvent","id":1,"id":2,"control":{"cancel":true}}', "duplicate key id")
RAW("raw-duplicate-id-wrong-case-sibling",
    '{"type":"deviceEvent","id":0,"Id":1,"control":{"cancel":true}}', "case-folded sibling is an unknown key, and id 0 is reserved")
RAW("raw-duplicate-type",
    '{"type":"deviceRequest","type":"deviceEvent","id":1,"control":{"cancel":true}}', "duplicate key type: never reinterpret as another message")
RAW("raw-duplicate-result",
    '{"type":"deviceResponse","id":1,"result":{"a":1},"result":{}}', "duplicate key result")
RAW("raw-duplicate-control-key",
    '{"type":"deviceEvent","id":1,"control":{"grant":1,"grant":2}}', "duplicate key inside control")
RAW("raw-duplicate-owner-key",
    '{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,'
    '"owner":{"moduleInstanceId":"a","moduleInstanceId":"b","activationId":1},'
    '"lifetime":"activation","timeoutMs":1000,"initialCredit":0,"params":{}}', "duplicate key inside owner")
RAW("raw-duplicate-key-inside-params",
    '{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,'
    '"owner":{"moduleInstanceId":"a","activationId":1},"lifetime":"activation",'
    '"timeoutMs":1000,"initialCredit":0,"params":{"maxCount":1,"maxCount":2}}', "duplicate key at any depth, including params")
RAW("raw-duplicate-key-inside-result",
    '{"type":"deviceResponse","id":1,"result":{"items":[{"channel":0,"channel":1}]}}', "duplicate key at any depth, including result")
RAW("raw-duplicate-key-inside-event",
    '{"type":"deviceEvent","id":1,"event":{"kind":"progress","kind":"blobStart"}}', "duplicate key at any depth, including event")
RAW("raw-duplicate-error-key",
    '{"type":"deviceResponse","id":1,"error":{"code":"denied","code":"internal"}}', "duplicate key inside error")
RAW("raw-id-minus-zero",
    '{"type":"deviceEvent","id":-0,"control":{"cancel":true}}', "-0 is not an integer literal for integer fields")
RAW("raw-grant-minus-zero",
    '{"type":"deviceEvent","id":1,"control":{"grant":-0}}', "-0 is not an integer literal for integer fields")
RAW("raw-activation-id-minus-zero",
    '{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,'
    '"owner":{"moduleInstanceId":"a","activationId":-0},"lifetime":"activation",'
    '"timeoutMs":1000,"initialCredit":0,"params":{}}', "-0 is not an integer literal for integer fields")

# ---------------------------------------------------------------- invalid: RFC 001 §2.1 JSON limits (D4)
# Numbers: integer tokens only, magnitude <= 2^53-1, in typed fields and inside params/result/event.
for tok in ["1.0", "1e0", "1E0", "1e+0", "10E-1", "-0", "-0.0", "0.5", "01", "+1", "1.", ".5",
            "1.0000000000000001", "4.294967295e9"]:
    RAW(f"raw-typed-number-{tok}", '{"type":"deviceEvent","id":%s,"control":{"cancel":true}}' % tok,
        "numbers are integer tokens: no fraction, exponent, -0, leading zero or plus sign",
        json_text=tok not in ("01", "+1", "1.", ".5"))
    RAW(f"raw-opaque-number-{tok}", ev_text('{"a":%s}' % tok),
        "the number rules hold inside params/result/event too",
        json_text=tok not in ("01", "+1", "1.", ".5"))
RAW("raw-grant-1.0", '{"type":"deviceEvent","id":1,"control":{"grant":1.0}}', "integer tokens only")
RAW("raw-opaque-2^53", ev_text('{"a":9007199254740992}'), "integer magnitude above 2^53-1")
RAW("raw-opaque-minus-2^53", ev_text('{"a":-9007199254740992}'), "integer magnitude above 2^53-1")
RAW("raw-opaque-17-digits", ev_text('{"a":12345678901234567}'), "at most 16 digits (2^53-1)")
RAW("raw-opaque-huge-integer", ev_text('{"a":%s}' % ("9" * 400)), "at most 16 digits (2^53-1)")
RAW("raw-opaque-1e400", ev_text('{"a":1e400}'), "exponent, and out of range")
# A million-digit integer token must be rejected in linear time (a quadratic big-number
# parse turns one message into a CPU denial of service).
RAW_REPEAT("raw-typed-integer-million-digits", '{"type":"deviceEvent","id":1', "0", 1000000,
           ',"control":{"cancel":true}}', "at most 16 digits; reject without a big-number parse")
RAW("raw-params-float",
    '{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,'
    '"owner":{"moduleInstanceId":"a","activationId":1},"lifetime":"activation",'
    '"timeoutMs":1000,"initialCredit":0,"params":{"mediaTypes":["photo"],"maxCount":1.0}}',
    "maxCount 1.0 is not an integer token (JSON Schema `integer` would accept it)")
# Literals: only true / false / null.
for tok in ["NaN", "Infinity", "-Infinity", "True", "TRUE", "Null", "nul", "tru", "abc", "undefined", "1abc"]:
    RAW(f"raw-bare-token-{tok}", ev_text('{"a":%s}' % tok), "not JSON: only true/false/null literals",
        json_text=False)
# Strings: valid UTF-8, no raw control characters, no lone surrogate escapes, in keys and values.
RAW("raw-control-char-in-value", ev_text('{"a":"x\u0001y"}'.replace("\\u0001", "\u0001")),
    "raw control character (< 0x20) in a string value", json_text=False)
RAW("raw-control-char-in-key", ev_text('{"a\u0001":1}'.replace("\\u0001", "\u0001")),
    "raw control character (< 0x20) in a key", json_text=False)
RAW("raw-tab-in-typed-value",
    '{"type":"deviceRequest","id":1,"capability":"gallery\tpick","version":1,'
    '"owner":{"moduleInstanceId":"a","activationId":1},"lifetime":"activation",'
    '"timeoutMs":1000,"initialCredit":0,"params":{}}', "raw TAB in a string", json_text=False)
RAW("raw-newline-in-platform-detail",
    '{"type":"deviceResponse","id":1,"error":{"code":"denied","platformDetail":"a\nb"}}',
    "raw LF in a string", json_text=False)
RAW("raw-nul-in-module-instance-id",
    '{"type":"deviceRequest","id":1,"capability":"gallery.pick","version":1,'
    '"owner":{"moduleInstanceId":"a\u0000","activationId":1},"lifetime":"activation",'
    '"timeoutMs":1000,"initialCredit":0,"params":{}}'.replace("\\u0000", "\u0000"),
    "raw NUL in a string", json_text=False)
RAW("raw-lone-high-surrogate-value", ev_text(r'{"a":"\ud800"}'), "lone surrogate escape")
RAW("raw-lone-low-surrogate-value", ev_text(r'{"a":"\udc00x"}'), "lone surrogate escape")
RAW("raw-reversed-surrogate-pair", ev_text(r'{"a":"\udc00\ud800"}'), "lone surrogate escapes")
RAW("raw-lone-surrogate-key", ev_text(r'{"\ud800":1}'), "lone surrogate escape in a key")
RAW("raw-lone-surrogate-typed", r'{"type":"deviceResponse","id":1,"error":{"code":"denied","platformDetail":"\ud800"}}',
    "lone surrogate escape in a typed string")
RAW("raw-invalid-escape", ev_text(r'{"a":"\x41"}'), "not a JSON escape", json_text=False)
RAW_HEX("rawhex-invalid-utf8-in-value", ev_text('{"a":"xy"}').encode().replace(b"xy", b"x\xffy"),
        "invalid UTF-8 byte 0xff in a string value")
RAW_HEX("rawhex-invalid-utf8-in-key", ev_text('{"ab":1}').encode().replace(b"ab", b"a\xc0b"),
        "invalid UTF-8 byte 0xc0 in a key")
RAW_HEX("rawhex-overlong-utf8", ev_text('{"a":"x"}').encode().replace(b'"x"', b'"\xc0\xaf"'),
        "overlong UTF-8 encoding")
RAW_HEX("rawhex-encoded-surrogate", ev_text('{"a":"x"}').encode().replace(b'"x"', b'"\xed\xa0\x80"'),
        "UTF-8-encoded surrogate (CESU)")
RAW_HEX("rawhex-truncated-utf8", ev_text('{"a":"x"}').encode().replace(b'"x"', b'"\xe2\x82"'),
        "truncated UTF-8 sequence")
RAW("raw-bom-prefix", "\ufeff" + '{"type":"deviceEvent","id":1,"control":{"cancel":true}}',
    "a byte-order mark is not JSON whitespace", json_text=False)
RAW("raw-trailing-data", '{"type":"deviceEvent","id":1,"control":{"cancel":true}} x',
    "trailing data after the message", json_text=False)
RAW("raw-escaped-duplicate-key", r'{"type":"deviceEvent","id":1,"\u0069d":2,"control":{"cancel":true}}',
    "duplicate keys compare after unescaping", json_text=True)
RAW("raw-escaped-duplicate-key-in-event", ev_text(r'{"k":1,"\u006b":2}'),
    "duplicate keys compare after unescaping, at any depth")
# Depth: 32 containers ok (valid cases), 33 rejected.
RAW("raw-depth-33", ev_text('{"a":%s}' % nest(31)), "nesting deeper than 32 containers")
RAW("raw-depth-33-objects", ev_text('{"a":' * 32 + "1" + "}" * 32), "nesting deeper than 32 containers")
RAW("raw-depth-2000", ev_text('{"a":%s}' % nest(2000)), "nesting deeper than 32 containers",
    json_text=False)
# Size: at most 1 MiB of text, checked before parsing.
RAW_REPEAT("raw-message-1-mib-plus-1", _head, " ", MSG_MAX - len(_head), "}",
           "device message larger than 1048576 bytes")
RAW_REPEAT("raw-garbage-over-1-mib", "", "x", MSG_MAX + 1, "",
           "the size check precedes parsing")
# Top-level shapes.
RAW("raw-top-level-array", '["deviceEvent",1,null,{"cancel":true}]', "a message is an object")
RAW("raw-top-level-null", "null", "a message is an object")
RAW("raw-top-level-string", '"deviceEvent"', "a message is an object")

# ---------------------------------------------------------------- handshake extension (D4, D7)
handshake = []
CORE_OFFER = {"name": "core.capabilities", "versions": [1]}
HELLO = {"protocolVersions": [1], "binary": True,
         "capabilities": [CORE_OFFER, {"name": "gallery.pick", "versions": [1, 2]}]}
ACK = {"protocolVersion": 1, "binary": True,
       "capabilities": [{"name": "core.capabilities", "version": 1}, {"name": "gallery.pick", "version": 1}]}
SNAP = {"capabilities": [CORE_OFFER, {"name": "gallery.pick", "versions": [1]}]}


def H(name, kind, value, valid_, reason=None, beyond=False):
    case = {"name": name, "kind": kind, "value": value, "valid": valid_}
    if reason:
        case["reason"] = reason
    if beyond:
        case["beyondSchema"] = True
    handshake.append(case)


def HRAW(name, kind, raw, reason):
    handshake.append({"name": name, "kind": kind, "raw": raw, "valid": False, "reason": reason})


H("hello-rfc-example", "hello", HELLO, True)
H("hello-empty-capabilities", "hello", with_(HELLO, capabilities=[]), True)
H("hello-canonically-equivalent-names-are-distinct", "hello",
  with_(HELLO, capabilities=[CORE_OFFER, {"name": "\u00e9", "versions": [1]}, {"name": "e\u0301", "versions": [1]}]), True)
H("hello-duplicate-capability-name", "hello",
  with_(HELLO, capabilities=[CORE_OFFER, {"name": "gallery.pick", "versions": [1]}, {"name": "gallery.pick", "versions": [2]}]),
  False, "capability names are unique in an advertisement", beyond=True)
H("hello-duplicate-protocol-version", "hello", with_(HELLO, protocolVersions=[1, 1]), False, "protocolVersions is a set")
H("hello-duplicate-offer-version", "hello",
  with_(HELLO, capabilities=[{"name": "core.capabilities", "versions": [1, 1]}]), False, "versions is a set")
H("hello-protocol-version-zero", "hello", with_(HELLO, protocolVersions=[0, 1]), False, "0 is reserved")
H("hello-offer-version-zero", "hello",
  with_(HELLO, capabilities=[{"name": "core.capabilities", "versions": [0]}]), False, "0 is reserved")
H("hello-9-protocol-versions", "hello", with_(HELLO, protocolVersions=list(range(1, 10))), False, "at most 8 protocol versions")
H("hello-65-capabilities", "hello",
  with_(HELLO, capabilities=[{"name": f"c{i}", "versions": [1]} for i in range(65)]), False, "at most 64 capabilities")
H("hello-empty-name", "hello", with_(HELLO, capabilities=[{"name": "", "versions": [1]}]), False, "names are 1..128 code points")
H("hello-name-129", "hello", with_(HELLO, capabilities=[{"name": "n" * 129, "versions": [1]}]), False, "names are 1..128 code points")
H("hello-extra-key", "hello", with_(HELLO, extra=1), False, "closed object")
H("hello-binary-null", "hello", with_(HELLO, binary=None), False, "binary is a boolean")
H("hello-offer-as-array", "hello", with_(HELLO, capabilities=[["core.capabilities", [1]]]), False,
  "an array never stands in for an offer object")
H("hello-as-array", "hello", [[1], True, [["core.capabilities", [1]]]], False, "an array never stands in for hello.device")
HRAW("hello-raw-duplicate-key", "hello",
     '{"protocolVersions":[1],"binary":false,"binary":true,"capabilities":[]}', "duplicate key")
HRAW("hello-raw-float-version", "hello",
     '{"protocolVersions":[1.0],"binary":true,"capabilities":[]}', "integer tokens only")
# 400k entries against maxItems 8: validators must bail out on the bound before any
# per-item (let alone pairwise uniqueItems) work.
handshake.append({"name": "hello-raw-400k-protocol-versions", "kind": "hello",
                  "rawRepeat": {"prefix": '{"protocolVersions":[', "repeat": "1,", "count": 400000,
                                "suffix": '1],"binary":true,"capabilities":[]}'},
                  "valid": False, "reason": "at most 8 protocol versions (and a set)"})
handshake.append({"name": "capabilities-event-raw-200k-versions", "kind": "capabilitiesEvent",
                  "rawRepeat": {"prefix": '{"capabilities":[{"name":"core.capabilities","versions":[',
                                "repeat": "1,", "count": 200000, "suffix": '1]}]}'},
                  "valid": False, "reason": "at most 32 versions per offer (and a set)"})
H("ack-rfc-example", "ack", ACK, True)
H("ack-duplicate-capability-name", "ack",
  with_(ACK, capabilities=[{"name": "gallery.pick", "version": 1}, {"name": "gallery.pick", "version": 2}]),
  False, "a selection names each capability once", beyond=True)
H("ack-protocol-version-zero", "ack", with_(ACK, protocolVersion=0), False, "0 is reserved")
H("ack-version-zero", "ack", with_(ACK, capabilities=[{"name": "core.capabilities", "version": 0}]), False, "0 is reserved")
H("ack-65-capabilities", "ack",
  with_(ACK, capabilities=[{"name": f"c{i}", "version": 1} for i in range(65)]), False, "at most 64 capabilities")
H("ack-extra-key", "ack", with_(ACK, limits={}), False, "closed object: v1 acks carry no limits")
H("ack-selection-as-array", "ack", with_(ACK, capabilities=[["core.capabilities", 1]]), False,
  "an array never stands in for a selection object")
H("capabilities-event-snapshot", "capabilitiesEvent", SNAP, True)
H("capabilities-event-empty", "capabilitiesEvent", {"capabilities": []}, True)
H("capabilities-event-duplicate-name", "capabilitiesEvent",
  {"capabilities": [CORE_OFFER, {"name": "core.capabilities", "versions": [1]}]},
  False, "capability names are unique in a snapshot", beyond=True)
H("capabilities-event-duplicate-version", "capabilitiesEvent",
  {"capabilities": [{"name": "core.capabilities", "versions": [1, 1]}]}, False, "versions is a set")

messages = {
    "description": (
        "Shared envelope-level conformance corpus (RFC 001 §2.1). Every SDK decodes each "
        "case from its JSON text with its strict device-message decoder + validator. "
        "`valid` cases must be accepted and must round-trip to an equal JSON value. "
        "`invalid` cases must be rejected at decode/validate. A case carries either "
        "`message` (a JSON value: serialize it to text, then decode) or `raw` (exact JSON "
        "text: needed for duplicate keys and number spellings a JSON value cannot hold). "
        "`beyondSchema: true` marks rules no JSON Schema keyword expresses (owner/lifetime "
        "agreement): the exported envelope schema accepts them, every decoder rejects them. "
        "All other invalid `message` cases are rejected by envelope-v1.schema.json too. "
        "String bounds count Unicode code points. Capability payloads (params/result/event) "
        "are covered by payloads.json, not here. A case carries exactly one of `message`, "
        "`raw` (exact JSON text), `rawHex` (hex of the exact text bytes, for bytes a JSON "
        "string cannot carry such as invalid UTF-8) or `rawRepeat` ({prefix, repeat, count, "
        "suffix}: text = prefix + repeat*count + suffix, for the 1 MiB size limit). The RFC 001 "
        "§2.1 JSON limits (1 MiB text checked before parsing, depth 32, integer tokens only "
        "within 2^53-1, no -0, valid UTF-8, no raw control characters or lone surrogates in "
        "keys and values, duplicate keys rejected) and canonical shapes (no array for an "
        "object, no map for an enum) apply to every decoder. `handshake` holds hello.device / "
        "sessionAck.device / core.capabilities snapshot cases ({name, kind: hello|ack|"
        "capabilitiesEvent, value|raw|rawRepeat, valid, beyondSchema?}); duplicate capability "
        "names are invalid in all three, names compare by exact code points."
    ),
    "valid": valid,
    "invalid": invalid,
    "handshake": handshake,
}

# ---------------------------------------------------------------- payloads
payload_cases = []


def P(name, capability, kind, value, valid_, beyond=False, version=1):
    case = {"name": name, "capability": capability, "version": version, "kind": kind,
            "value": value, "valid": valid_}
    if beyond:
        case["beyondSchema"] = True
    payload_cases.append(case)


def item(ch=0, bytes_=17, sha=SHA, ct="image/jpeg"):
    return {"channel": ch, "contentType": ct, "bytes": bytes_, "sha256": sha}


def fitem(ch=0, bytes_=17, sha=SHA):
    return {"channel": ch, "name": "doc.pdf", "contentType": "application/pdf", "bytes": bytes_, "sha256": sha}


FS = {"channel": 0, "name": "report.txt", "contentType": "text/plain", "bytes": 11, "sha256": SHA}

P("gallery-params-minimal", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 1}, True)
P("gallery-params-both-media-max-count", "gallery.pick", "params", {"mediaTypes": ["photo", "video"], "maxCount": 16}, True)
P("gallery-params-media-types-empty", "gallery.pick", "params", {"mediaTypes": [], "maxCount": 1}, False)
P("gallery-params-media-types-duplicate", "gallery.pick", "params", {"mediaTypes": ["photo", "photo"], "maxCount": 1}, False)
P("gallery-params-media-types-triple", "gallery.pick", "params", {"mediaTypes": ["photo", "photo", "photo"], "maxCount": 1}, False)
P("gallery-params-media-types-null", "gallery.pick", "params", {"mediaTypes": None, "maxCount": 1}, False)
P("gallery-params-max-count-zero", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 0}, False)
P("gallery-params-max-count-over-max-items", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 17}, False)
P("gallery-params-max-count-40000", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 40000}, False)
P("gallery-params-missing-max-count", "gallery.pick", "params", {"mediaTypes": ["photo"]}, False)
P("gallery-params-extra-key", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 1, "x": 1}, False)
P("gallery-result-one-item", "gallery.pick", "result", {"items": [item()]}, True)
P("gallery-result-no-items", "gallery.pick", "result", {"items": []}, True)
P("gallery-result-item-at-max-item-bytes", "gallery.pick", "result", {"items": [item(bytes_=64 * MIB)]}, True)
P("gallery-result-item-over-max-item-bytes", "gallery.pick", "result", {"items": [item(bytes_=64 * MIB + 1)]}, False)
P("gallery-result-item-one-tib", "gallery.pick", "result", {"items": [item(bytes_=1 << 40)]}, False)
P("gallery-result-duplicate-channels", "gallery.pick", "result", {"items": [item(0), item(0)]}, False, beyond=True)
P("gallery-result-channel-over-max-items", "gallery.pick", "result", {"items": [item(16)]}, False)
P("gallery-result-sha256-uppercase", "gallery.pick", "result", {"items": [item(sha=SHA.upper())]}, False)
P("gallery-result-sha256-garbage", "gallery.pick", "result", {"items": [item(sha="DEADBEEF")]}, False)
P("gallery-result-sha256-empty", "gallery.pick", "result", {"items": [item(sha="")]}, False)
P("gallery-result-content-type-257", "gallery.pick", "result", {"items": [item(ct="t" * 257)]}, False)
P("gallery-result-17-items", "gallery.pick", "result", {"items": [item(i) for i in range(17)]}, False)
P("gallery-result-wrong-shape", "gallery.pick", "result", {"bytesWritten": 3}, False)
P("gallery-event-blob-start", "gallery.pick", "event", {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 17}, True)
P("gallery-event-blob-start-over-max-item-bytes", "gallery.pick", "event", {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 1 << 40}, False)
P("gallery-event-blob-start-wrong-kind", "gallery.pick", "event", {"kind": "blobStrat", "channel": 0, "contentType": "image/jpeg", "bytes": 17}, False)
P("gallery-event-blob-start-extra-key", "gallery.pick", "event", {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 17, "x": 1}, False)
P("gallery-event-progress-pending-consent", "gallery.pick", "event", {"kind": "progress", "state": "pendingConsent"}, True)
P("gallery-event-progress-running", "gallery.pick", "event", {"kind": "progress", "state": "running"}, True)
P("gallery-event-progress-unknown-state", "gallery.pick", "event", {"kind": "progress", "state": "paused"}, False)
P("gallery-event-unknown-kind", "gallery.pick", "event", {"kind": "progress2"}, False)
P("file-pick-params", "file.pick", "params", {"accept": ["application/pdf", "image/*"], "maxCount": 2}, True)
P("file-pick-params-accept-empty", "file.pick", "params", {"accept": [], "maxCount": 1}, True)
P("file-pick-params-accept-entry-129", "file.pick", "params", {"accept": ["a" * 129], "maxCount": 1}, False)
P("file-pick-params-accept-33-entries", "file.pick", "params", {"accept": ["a"] * 33, "maxCount": 1}, False)
P("file-pick-params-accept-null-entry", "file.pick", "params", {"accept": [None], "maxCount": 1}, False)
P("file-pick-result", "file.pick", "result", {"items": [fitem()]}, True)
P("file-pick-result-duplicate-channels", "file.pick", "result", {"items": [fitem(1), fitem(1)]}, False, beyond=True)
P("file-pick-result-name-513", "file.pick", "result", {"items": [dict(fitem(), name="n" * 513)]}, False)
P("file-pick-event-blob-start", "file.pick", "event", {"kind": "blobStart", "channel": 0, "contentType": "application/pdf", "bytes": 3}, True)
P("file-save-params", "file.save", "params", FS, True)
P("file-save-params-channel-nonzero", "file.save", "params", dict(FS, channel=9), False)
P("file-save-params-bytes-zero", "file.save", "params", dict(FS, bytes=0), False)
P("file-save-params-bytes-over-max-item-bytes", "file.save", "params", dict(FS, bytes=64 * MIB + 1), False)
P("file-save-params-sha256-empty", "file.save", "params", dict(FS, sha256=""), False)
P("file-save-params-content-type-null", "file.save", "params", dict(FS, contentType=None), False)
P("file-save-result", "file.save", "result", {"bytesWritten": 11}, True)
P("file-save-result-over-max-item-bytes", "file.save", "result", {"bytesWritten": 64 * MIB + 1}, False)
P("file-save-event-blob-start-not-on-download", "file.save", "event", {"kind": "blobStart", "channel": 0, "contentType": "a", "bytes": 1}, False)
P("file-save-event-progress", "file.save", "event", {"kind": "progress", "state": "running"}, True)
P("permission-query-params", "permission.query", "params", {"permission": "microphone"}, True)
P("permission-query-params-unknown-64-chars", "permission.query", "params", {"permission": "p" * 64}, False)
P("permission-query-params-65", "permission.query", "params", {"permission": "p" * 65}, False)
P("permission-query-params-5000", "permission.query", "params", {"permission": "p" * 5000}, False)
P("permission-query-params-null", "permission.query", "params", {"permission": None}, False)
P("permission-query-params-missing", "permission.query", "params", {}, False)
P("permission-query-result", "permission.query", "result", {"status": "prompt"}, True)
P("permission-query-result-unknown-status", "permission.query", "result", {"status": "maybe"}, False)
P("permission-query-event-blob-start", "permission.query", "event", {"kind": "blobStart", "channel": 0, "contentType": "a", "bytes": 1}, False)
P("permission-request-event-progress", "permission.request", "event", {"kind": "progress", "state": "pendingConsent"}, True)
P("permission-request-result-granted", "permission.request", "result", {"status": "granted"}, True)
P("bluetooth-params-empty", "bluetooth.scan", "params", {}, True)
P("bluetooth-params-extra-key", "bluetooth.scan", "params", {"x": 1}, False)
P("bluetooth-event-device", "bluetooth.scan", "event", {"device": {"id": "aa:bb", "name": "Speaker", "rssi": -40}}, True)
P("bluetooth-event-device-name-empty-string-is-present", "bluetooth.scan", "event", {"device": {"id": "aa:bb", "name": "", "rssi": -40}}, True)
P("bluetooth-event-device-name-null", "bluetooth.scan", "event", {"device": {"id": "aa:bb", "name": None, "rssi": -40}}, False)
P("bluetooth-event-device-missing", "bluetooth.scan", "event", {}, False)
P("bluetooth-event-device-null", "bluetooth.scan", "event", {"device": None}, False)
P("bluetooth-event-rssi-missing", "bluetooth.scan", "event", {"device": {"id": "a"}}, False)
P("bluetooth-event-rssi-out-of-range", "bluetooth.scan", "event", {"device": {"id": "a", "rssi": 32768}}, False)
P("bluetooth-event-blob-start-not-on-json-plane", "bluetooth.scan", "event", {"kind": "blobStart", "channel": 0, "contentType": "a", "bytes": 1}, False)
P("bluetooth-result-empty", "bluetooth.scan", "result", {}, True)
P("mic-params", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16"}, True)
P("mic-params-sample-rate-min", "mic.record", "params", {"sampleRate": 8000, "format": "pcm16"}, True)
P("mic-params-sample-rate-1", "mic.record", "params", {"sampleRate": 1, "format": "pcm16"}, False)
P("mic-params-sample-rate-over-max", "mic.record", "params", {"sampleRate": 192001, "format": "pcm16"}, False)
P("mic-params-unknown-format", "mic.record", "params", {"sampleRate": 16000, "format": "opus"}, False)
P("mic-result", "mic.record", "result", {"durationMs": 1, "item": item(0, 32, SHA, "audio/L16")}, True)
P("mic-result-channel-1", "mic.record", "result", {"durationMs": 1, "item": item(1, 32, SHA, "audio/L16")}, False)
P("mic-event-blob-start", "mic.record", "event", {"kind": "blobStart", "channel": 0, "contentType": "audio/L16", "bytes": 32}, True)
P("core-params-empty", "core.capabilities", "params", {}, True)
P("core-event-snapshot", "core.capabilities", "event", {"capabilities": [{"name": "core.capabilities", "versions": [1]}, {"name": "gallery.pick", "versions": [1]}]}, True)
P("core-event-empty-snapshot", "core.capabilities", "event", {"capabilities": []}, True)
P("core-event-version-zero", "core.capabilities", "event", {"capabilities": [{"name": "a", "versions": [0]}]}, False)
P("core-event-duplicate-versions", "core.capabilities", "event", {"capabilities": [{"name": "a", "versions": [1, 1]}]}, False)
P("core-event-duplicate-names", "core.capabilities", "event", {"capabilities": [{"name": "a", "versions": [1]}, {"name": "a", "versions": [2]}]}, False, beyond=True)
P("core-event-empty-name", "core.capabilities", "event", {"capabilities": [{"name": "", "versions": [1]}]}, False)
P("core-event-33-versions", "core.capabilities", "event", {"capabilities": [{"name": "a", "versions": list(range(1, 34))}]}, False)
P("core-event-65-offers", "core.capabilities", "event", {"capabilities": [{"name": f"c{i}", "versions": [1]} for i in range(65)]}, False)
P("core-event-100-offers-versions-zero", "core.capabilities", "event", {"capabilities": [{"name": f"c{i}", "versions": [0, 0]} for i in range(100)]}, False)
P("gallery-v2-unknown-revision", "gallery.pick", "params", {"mediaTypes": ["photo"], "maxCount": 1}, False, version=2)

# Optional blob sizes (decision D5): blobStart `bytes` is optional on every upload revision.
for cap, ct in [("gallery.pick", "image/jpeg"), ("file.pick", "application/pdf"), ("mic.record", "audio/L16")]:
    short = cap.split(".")[0]
    P(f"{short}-event-blob-start-undeclared-size", cap, "event", {"kind": "blobStart", "channel": 0, "contentType": ct}, True)
    P(f"{short}-event-blob-start-zero-bytes", cap, "event", {"kind": "blobStart", "channel": 0, "contentType": ct, "bytes": 0}, True)
    P(f"{short}-event-blob-start-bytes-null", cap, "event", {"kind": "blobStart", "channel": 0, "contentType": ct, "bytes": None}, False)
    P(f"{short}-event-blob-start-at-max-item-bytes", cap, "event", {"kind": "blobStart", "channel": 0, "contentType": ct, "bytes": 64 * MIB}, True)
    P(f"{short}-event-blob-start-max-item-bytes-plus-1", cap, "event", {"kind": "blobStart", "channel": 0, "contentType": ct, "bytes": 64 * MIB + 1}, False)
P("gallery-result-empty-item", "gallery.pick", "result",
  {"items": [item(0, 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "text/plain")]}, True)
P("mic-params-max-duration-min", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxDurationMs": 1}, True)
P("mic-params-max-duration-max", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxDurationMs": 600000}, True)
P("mic-params-max-duration-zero", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxDurationMs": 0}, False)
P("mic-params-max-duration-over-max", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxDurationMs": 600001}, False)
P("mic-params-max-duration-null", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxDurationMs": None}, False)
P("mic-params-max-bytes-is-not-a-param", "mic.record", "params", {"sampleRate": 16000, "format": "pcm16", "maxBytes": 1024}, False)

# Canonical shapes: an array never stands in for an object, nor a one-key map for an enum string.
P("gallery-result-item-as-array", "gallery.pick", "result", {"items": [[0, "image/jpeg", 3, SHA]]}, False)
P("mic-result-item-as-array", "mic.record", "result", {"durationMs": 5, "item": [0, "audio/wav", 3, SHA]}, False)
P("file-pick-result-item-as-array", "file.pick", "result", {"items": [[0, "a", "b", 3, SHA]]}, False)
P("bluetooth-event-device-as-array", "bluetooth.scan", "event", {"device": ["dev1", "name", -40]}, False)
P("core-event-offer-as-array", "core.capabilities", "event", {"capabilities": [["gallery.pick", [1]]]}, False)
P("gallery-params-media-type-as-map", "gallery.pick", "params", {"mediaTypes": [{"photo": None}], "maxCount": 1}, False)
P("permission-result-status-as-map", "permission.query", "result", {"status": {"granted": None}}, False)
P("mic-params-format-as-map", "mic.record", "params", {"sampleRate": 8000, "format": {"pcm16": None}}, False)
P("gallery-event-progress-state-as-map", "gallery.pick", "event", {"kind": "progress", "state": {"running": None}}, False)
P("permission-params-as-array", "permission.query", "params", ["photo"], False)
P("bluetooth-params-as-array", "bluetooth.scan", "params", [], False)
P("core-params-as-array", "core.capabilities", "params", [], False)

# ---------------------------------------------------------------- round 3
# P1 typed permissions: the closed Permission enum, identical on every host.
PERMISSIONS = ["camera", "microphone", "photos", "location", "notifications", "bluetooth", "contacts"]
for cap in ["permission.query", "permission.request"]:
    short = cap.replace(".", "-")
    for perm in PERMISSIONS:
        P(f"{short}-params-{perm}", cap, "params", {"permission": perm}, True)
    for label, perm in [("typo-camra", "camra"), ("alias-geolocation", "geolocation"),
                        ("singular-photo", "photo"), ("singular-notification", "notification"),
                        ("wrong-case-camera", "Camera"), ("upper-case-microphone", "MICROPHONE"),
                        ("trailing-space", "camera "), ("empty", ""), ("storage", "storage"),
                        ("bluetooth-scan", "bluetooth.scan"), ("astral", ASTRAL)]:
        P(f"{short}-params-unknown-{label}", cap, "params", {"permission": perm}, False)
    P(f"{short}-params-number", cap, "params", {"permission": 1}, False)
    P(f"{short}-params-array", cap, "params", {"permission": ["camera"]}, False)
    P(f"{short}-params-map-for-enum", cap, "params", {"permission": {"camera": None}}, False)
    P(f"{short}-params-extra-key", cap, "params", {"permission": "camera", "reason": "x"}, False)
    for status in ["granted", "denied", "prompt"]:
        P(f"{short}-result-status-{status}", cap, "result", {"status": status}, True)
    P(f"{short}-result-status-null", cap, "result", {"status": None}, False)

# Result coverage for every registry revision (valid and invalid).
P("core-result-empty", "core.capabilities", "result", {}, True)
P("core-result-extra-key", "core.capabilities", "result", {"capabilities": []}, False)
P("bluetooth-result-extra-key", "bluetooth.scan", "result", {"device": {"id": "a", "rssi": -1}}, False)

# C2 camera.capture@1.
JPEG_ITEM = item(0, 17, SHA, "image/jpeg")
P("camera-params-photo", "camera.capture", "params", {"mode": "photo"}, True)
P("camera-params-photo-front", "camera.capture", "params", {"mode": "photo", "facing": "front"}, True)
P("camera-params-video", "camera.capture", "params", {"mode": "video"}, True)
P("camera-params-video-back-max-duration", "camera.capture", "params", {"mode": "video", "facing": "back", "maxDurationMs": 15000}, True)
P("camera-params-video-max-duration-min", "camera.capture", "params", {"mode": "video", "maxDurationMs": 1}, True)
P("camera-params-video-max-duration-max", "camera.capture", "params", {"mode": "video", "maxDurationMs": 600000}, True)
P("camera-params-video-max-duration-zero", "camera.capture", "params", {"mode": "video", "maxDurationMs": 0}, False)
P("camera-params-video-max-duration-over-max", "camera.capture", "params", {"mode": "video", "maxDurationMs": 600001}, False)
P("camera-params-video-max-duration-null", "camera.capture", "params", {"mode": "video", "maxDurationMs": None}, False)
P("camera-params-photo-with-max-duration", "camera.capture", "params", {"mode": "photo", "maxDurationMs": 1000}, False)
P("camera-params-photo-with-max-duration-and-facing", "camera.capture", "params", {"mode": "photo", "facing": "back", "maxDurationMs": 1}, False)
P("camera-params-mode-missing", "camera.capture", "params", {"facing": "front"}, False)
P("camera-params-mode-unknown", "camera.capture", "params", {"mode": "audio"}, False)
P("camera-params-mode-wrong-case", "camera.capture", "params", {"mode": "Photo"}, False)
P("camera-params-mode-as-map", "camera.capture", "params", {"mode": {"photo": None}}, False)
P("camera-params-facing-unknown", "camera.capture", "params", {"mode": "photo", "facing": "user"}, False)
P("camera-params-facing-null", "camera.capture", "params", {"mode": "photo", "facing": None}, False)
P("camera-params-extra-key", "camera.capture", "params", {"mode": "photo", "quality": 90}, False)
P("camera-params-empty", "camera.capture", "params", {}, False)
P("camera-params-as-array", "camera.capture", "params", ["photo"], False)
for ct in ["image/jpeg", "image/heic", "video/mp4", "video/quicktime", "video/webm"]:
    tag = ct.replace("/", "-")
    P(f"camera-result-{tag}", "camera.capture", "result", {"items": [item(0, 17, SHA, ct)]}, True)
    P(f"camera-event-blob-start-{tag}-undeclared", "camera.capture", "event",
      {"kind": "blobStart", "channel": 0, "contentType": ct}, True)
P("camera-result-at-max-item-bytes", "camera.capture", "result", {"items": [item(0, 64 * MIB, SHA, "video/mp4")]}, True)
P("camera-result-over-max-item-bytes", "camera.capture", "result", {"items": [item(0, 64 * MIB + 1, SHA, "video/mp4")]}, False)
P("camera-result-no-items", "camera.capture", "result", {"items": []}, False)
P("camera-result-two-items", "camera.capture", "result", {"items": [JPEG_ITEM, item(1, 17, SHA, "image/jpeg")]}, False)
P("camera-result-two-items-same-channel", "camera.capture", "result", {"items": [JPEG_ITEM, JPEG_ITEM]}, False)
P("camera-result-channel-1", "camera.capture", "result", {"items": [item(1, 17, SHA, "image/jpeg")]}, False)
P("camera-result-content-type-png", "camera.capture", "result", {"items": [item(0, 17, SHA, "image/png")]}, False)
P("camera-result-content-type-with-codecs", "camera.capture", "result", {"items": [item(0, 17, SHA, "video/webm;codecs=vp8")]}, False)
P("camera-result-content-type-upper-case", "camera.capture", "result", {"items": [item(0, 17, SHA, "IMAGE/JPEG")]}, False)
P("camera-result-sha256-garbage", "camera.capture", "result", {"items": [item(0, 17, "DEADBEEF", "image/jpeg")]}, False)
P("camera-result-item-not-items", "camera.capture", "result", {"item": JPEG_ITEM}, False)
P("camera-result-item-as-array", "camera.capture", "result", {"items": [[0, "image/jpeg", 17, SHA]]}, False)
P("camera-event-blob-start-declared", "camera.capture", "event", {"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 17}, True)
P("camera-event-blob-start-channel-1", "camera.capture", "event", {"kind": "blobStart", "channel": 1, "contentType": "image/jpeg"}, False)
P("camera-event-blob-start-content-type-png", "camera.capture", "event", {"kind": "blobStart", "channel": 0, "contentType": "image/png"}, False)
P("camera-event-blob-start-over-max-item-bytes", "camera.capture", "event", {"kind": "blobStart", "channel": 0, "contentType": "video/mp4", "bytes": 64 * MIB + 1}, False)
P("camera-event-progress", "camera.capture", "event", {"kind": "progress", "state": "pendingConsent"}, True)
P("camera-event-bluetooth-device", "camera.capture", "event", {"device": {"id": "a", "rssi": -1}}, False)

# C3 mic.record@1 `channels`.
MIC = {"sampleRate": 48000, "format": "pcm16"}
P("mic-params-channels-1", "mic.record", "params", dict(MIC, channels=1), True)
P("mic-params-channels-2", "mic.record", "params", dict(MIC, channels=2), True)
P("mic-params-channels-2-with-max-duration", "mic.record", "params", dict(MIC, channels=2, maxDurationMs=500), True)
P("mic-params-channels-0", "mic.record", "params", dict(MIC, channels=0), False)
P("mic-params-channels-3", "mic.record", "params", dict(MIC, channels=3), False)
P("mic-params-channels-256", "mic.record", "params", dict(MIC, channels=256), False)
P("mic-params-channels-negative", "mic.record", "params", dict(MIC, channels=-1), False)
P("mic-params-channels-null", "mic.record", "params", dict(MIC, channels=None), False)
P("mic-params-channels-string", "mic.record", "params", dict(MIC, channels="2"), False)
P("mic-params-channels-array", "mic.record", "params", dict(MIC, channels=[2]), False)

# C4 bluetooth.select@1.
HR = "0000180d-0000-1000-8000-00805f9b34fb"
BATTERY = "0000180f-0000-1000-8000-00805f9b34fb"
P("bt-select-params-empty", "bluetooth.select", "params", {}, True)
P("bt-select-params-services", "bluetooth.select", "params", {"services": [HR, BATTERY]}, True)
P("bt-select-params-name-prefix", "bluetooth.select", "params", {"namePrefix": "Polar"}, True)
P("bt-select-params-both", "bluetooth.select", "params", {"services": [HR], "namePrefix": "H"}, True)
P("bt-select-params-16-services", "bluetooth.select", "params", {"services": [f"{i:08x}-0000-1000-8000-00805f9b34fb" for i in range(16)]}, True)
P("bt-select-params-name-prefix-64-astral-code-points", "bluetooth.select", "params", {"namePrefix": ASTRAL * 64}, True)
P("bt-select-params-17-services", "bluetooth.select", "params", {"services": [f"{i:08x}-0000-1000-8000-00805f9b34fb" for i in range(17)]}, False)
P("bt-select-params-services-empty", "bluetooth.select", "params", {"services": []}, False)
P("bt-select-params-services-duplicate", "bluetooth.select", "params", {"services": [HR, HR]}, False)
P("bt-select-params-services-null", "bluetooth.select", "params", {"services": None}, False)
for label, uuid in [("short-hex-0x180d", "0x180d"), ("short-hex-180d", "180d"), ("upper-case", HR.upper()),
                    ("no-dashes", HR.replace("-", "")), ("braced", "{" + HR + "}"), ("too-short", HR[:-1]),
                    ("too-long", HR + "b"), ("non-hex", "0000180g" + HR[8:]), ("underscore", HR.replace("-", "_", 1)),
                    ("gatt-name", "heart_rate"), ("number", 6157), ("empty", "")]:
    P(f"bt-select-params-uuid-{label}", "bluetooth.select", "params", {"services": [uuid]}, False)
P("bt-select-params-name-prefix-empty", "bluetooth.select", "params", {"namePrefix": ""}, False)
P("bt-select-params-name-prefix-65", "bluetooth.select", "params", {"namePrefix": "x" * 65}, False)
P("bt-select-params-name-prefix-null", "bluetooth.select", "params", {"namePrefix": None}, False)
P("bt-select-params-accept-all-devices-is-not-a-param", "bluetooth.select", "params", {"acceptAllDevices": True}, False)
P("bt-select-params-as-array", "bluetooth.select", "params", [], False)
P("bt-select-result", "bluetooth.select", "result", {"device": {"id": "dev-1", "name": "Polar H10"}}, True)
P("bt-select-result-no-name", "bluetooth.select", "result", {"device": {"id": "dev-1"}}, True)
P("bt-select-result-name-empty-string-is-present", "bluetooth.select", "result", {"device": {"id": "dev-1", "name": ""}}, True)
P("bt-select-result-bounds", "bluetooth.select", "result", {"device": {"id": ASTRAL * 128, "name": ASTRAL * 256}}, True)
P("bt-select-result-id-empty", "bluetooth.select", "result", {"device": {"id": ""}}, False)
P("bt-select-result-id-129", "bluetooth.select", "result", {"device": {"id": "x" * 129}}, False)
P("bt-select-result-name-257", "bluetooth.select", "result", {"device": {"id": "a", "name": "n" * 257}}, False)
P("bt-select-result-name-null", "bluetooth.select", "result", {"device": {"id": "a", "name": None}}, False)
P("bt-select-result-rssi-is-scan-only", "bluetooth.select", "result", {"device": {"id": "a", "rssi": -40}}, False)
P("bt-select-result-device-missing", "bluetooth.select", "result", {}, False)
P("bt-select-result-device-null", "bluetooth.select", "result", {"device": None}, False)
P("bt-select-result-device-as-array", "bluetooth.select", "result", {"device": ["dev-1", "Polar"]}, False)
P("bt-select-result-extra-key", "bluetooth.select", "result", {"device": {"id": "a"}, "services": []}, False)
P("bt-select-event-progress", "bluetooth.select", "event", {"kind": "progress", "state": "pendingConsent"}, True)
P("bt-select-event-scan-device-not-an-event", "bluetooth.select", "event", {"device": {"id": "a", "rssi": -40}}, False)
P("bt-select-event-blob-start-not-on-json-plane", "bluetooth.select", "event", {"kind": "blobStart", "channel": 0, "contentType": "a"}, False)

# Handshake-adjacent snapshot rules (decision D7): names compare by exact code points.
P("core-event-canonically-equivalent-names-are-distinct", "core.capabilities", "event",
  {"capabilities": [{"name": "\u00e9", "versions": [1]}, {"name": "e\u0301", "versions": [1]}]}, True)
P("core-event-without-core-capabilities", "core.capabilities", "event",
  {"capabilities": [{"name": "gallery.pick", "versions": [1]}]}, True)

payloads = {
    "description": (
        "Per-revision capability payload corpus. Validate `value` as the `kind` "
        "(params | result | event) of `capability` at `version` with the SDK's typed "
        "decoder + revision bounds (registry-v1.json). `valid` is the required verdict. "
        "Event validation covers the revision's whole event union: capability stream "
        "events, `blobStart` on binaryUpload revisions, and `progress` on every revision. "
        "`beyondSchema: true` marks rules the exported capability schema cannot express "
        "(unique channels, unique capability names); every other verdict matches the "
        "capability schema's `$defs/<kind>`. A revision absent from the registry is invalid."
    ),
    "cases": payload_cases,
}


def dump(name, doc):
    with open(os.path.join(ROOT, name), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


dump("messages.json", messages)
dump("payloads.json", payloads)
print(len(valid), "valid", len(invalid), "invalid messages;", len(payload_cases), "payload cases")
