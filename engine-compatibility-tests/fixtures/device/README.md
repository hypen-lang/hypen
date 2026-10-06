# Device Capability Protocol fixtures (RFC 001, provisional)

Cross-SDK fixtures for the device capability protocol. These do **not** use
`test-case.schema.json` (that format drives the synchronous rendering engine);
device conformance needs transports, sessions, and async flows, so it gets its
own format and, per SDK, its own async runner (portable-style — see
`fixtures/portable/` for the precedent).

Everything here is provisional until the RFC 001 §6 Phase 4 real-driver gate;
fixtures may change together with the draft schemas until then.

## Decoding rules every SDK shares

Decode device messages from the **JSON text**. RFC 001 §2.1 has the normative
table; in order:

1. **JSON limits** — one set, applied to the whole message (envelope *and*
   `params`/`result`/`event`) and to the handshake objects:
   - at most **1,048,576 bytes** of UTF-8 text, checked **before** parsing;
   - nesting depth at most **32 containers** (`{` or `[`; scalars do not
     count; the envelope object is depth 1); 33 is rejected;
   - numbers are **integer tokens only** (`-?(0|[1-9][0-9]*)`): no fraction,
     no exponent, no `-0`, at most 16 digits and magnitude at most
     2^53 − 1 (`9007199254740991`); field schemas are tighter. `1.0`, `1e0`,
     `1E0`, `-0.0` are invalid everywhere — JSON Schema's `integer` would
     accept `1.0`, so these cases are text (`raw`) cases;
   - strings are valid UTF-8 with no raw control characters (< 0x20) and no
     lone surrogate escapes, in keys **and** values; lengths count Unicode
     code points;
   - duplicate keys (compared after unescaping: `"id"` and `"\u0069d"`
     collide) are rejected at any depth;
   - only the literals `true`, `false`, `null`; no BOM, no trailing data.
2. **Closed typed decoding**: exact-case keys (`"ID"` is an unknown key);
   `null` never stands in for an absent or typed member (`"platformDetail":
   null`, `"simulated": null`, `"result": null` are invalid;
   `"platformDetail": ""` is present and round-trips as present).
3. **Canonical shapes**: an object where the schema says object (never an
   array or positional form), a string where the schema says enum (never a
   one-key map). Re-encoding a decoded message gives back the input value.
4. `owner` is exactly one of `{moduleInstanceId, activationId}`,
   `{moduleInstanceId}`, `{connection: true}`; a malformed activation owner is
   rejected, never downgraded. Its shape must match `lifetime`. `control` has
   exactly one key; `cancel` is `const true`; `grant` ≥ 1 and ≤ the largest
   registry `maxOutstandingCredit`; lease sequences (`renewLease`/`leaseAck`)
   are u32 in 1..4294967295, like ids and frame `seq`. `simulated` is
   `const true` when present.

**Attribution** of an invalid message (decisions D3/D8): text that breaks the
JSON limits is attributable to *no* request — a connection-level violation,
discarded and counted, never terminating a request (like a bad frame header).
A message within the limits whose `type` is a device type and whose `id` is an
integer in 1..4294967295, but which fails steps 2–4, is a *known-id invalid
message* when that id is live for its receiver, and ignored when it is not.

## `conformance/` — shared decode/validate/selection corpus

**`messages.json`** — envelope-level cases:

```jsonc
{"valid":   [{"name", "message": {…}} | {"name", "raw": "…"} | {"name", "rawRepeat": {…}}],
 "invalid": [{"name", "reason", "message": {…}, "beyondSchema": true?},
             {"name", "reason", "raw": "<exact JSON text>"},
             {"name", "reason", "rawHex": "<hex of the exact text bytes>"},
             {"name", "reason", "rawRepeat": {"prefix", "repeat", "count", "suffix"}}],
 "handshake": [{"name", "kind": "hello"|"ack"|"capabilitiesEvent",
                "value": {…} | "raw": "…" | "rawRepeat": {…}, "valid": bool, "reason"?,
                "beyondSchema"?}]}
```

Each case carries exactly one form:

- `message`: a JSON value; serialize it to text, then decode.
- `raw`: exact JSON text (duplicate keys, number spellings, control
  characters, lone surrogate escapes, depth, bare tokens, BOM…).
- `rawHex`: the exact text bytes in lowercase hex, for bytes a JSON string
  cannot carry (invalid UTF-8, overlong or surrogate encodings). Decode the
  bytes as a WebSocket text frame would arrive.
- `rawRepeat`: `text = prefix + repeat × count + suffix`, for the 1 MiB size
  limit without a megabyte fixture (`raw-message-exactly-1-mib` is valid,
  `raw-message-1-mib-plus-1` is not).

Every `valid` case is accepted and round-trips to an equal JSON value (for
text cases: equal to the parsed text); every `invalid` case is rejected.
`beyondSchema: true` marks rules no JSON Schema keyword expresses (owner /
lifetime agreement, unique capability names): the exported schema accepts
those, every decoder rejects them. All other invalid `message` cases are
schema-invalid too; text cases test decoder-only rules.

`handshake` cases decode `hello.device`, `sessionAck.device` or a
`core.capabilities` snapshot body with the same JSON limits and closed
decoding; duplicate capability names are invalid in all three (compared by
exact code points: `"\u00e9"` and `"e\u0301"` are different names). Value cases
also match `handshake-v1.schema.json` `$defs/deviceHello|deviceAck|capabilitiesEvent`
unless `beyondSchema`.

**`payloads.json`** — per-revision capability payloads:

```jsonc
{"cases": [{"name", "capability", "version", "kind": "params"|"result"|"event",
            "value", "valid": bool, "beyondSchema": true?}]}
```

Validate `value` against the selected revision with the typed decoder and the
revision bounds from `schema/device/registry-v1.json`. Event validation covers
the whole event union of the revision: capability stream events, `blobStart`
on `binaryUpload` revisions, and `progress`
(`{"kind":"progress","state":"pendingConsent"|"running"}`) on every revision.
`blobStart.bytes` is optional (decision D5). `beyondSchema` marks rules
capability schemas cannot express (unique item channels, unique capability
names). Validate against `#/$defs/params|result|event`; a capability
document's root is an `anyOf` of the three.

**`selection.json`** — table-driven handshake selection:

```jsonc
{"cases": [{"name", "description", "serverCapabilities": [{"name", "versions"}],
            "serverBinary": bool, "serverProtocolVersions": [1]?,
            "hello": { /* hello.device */ }, "expect": { /* sessionAck.device */ } | null}]}
```

`serverProtocolVersions` defaults to `[1]`. `expect: null` means device access
is disabled. `select_device_ack` validates the hello first: a `hello.device`
failing handshake-v1 (reserved 0, too many entries, bad names, duplicates)
disables device access. Then RFC §2.2 rules (a)–(d): version 0 never
selected (also from the server's own lists); `core.capabilities` revision 1
mandatory; no binary-plane revision without negotiated binary; duplicates in
the hello disable device access. Duplicate server entries: the first wins,
never merged. Names compare by exact code points. Revisions the registry does
not declare are never selected.

## `transcripts/*.json` — message-sequence fixtures

Two shapes, distinguished by their top-level keys (both closed: unknown keys
are fixture errors, and so are duplicate keys anywhere in a fixture file).
The file name equals `name`.

### Wire transcripts

```jsonc
{"name", "description", "protocol": 1,
 "ack": { /* sessionAck.device */ }?,               // default: every registry capability, binary true
 "serverCapabilities": [{"name", "versions"}]?,    // default: the ack's selection
 "steps": [ … ]}
```

An ordered exchange on one physical connection whose device handshake
selected `ack`. Each step is one of

```jsonc
{"dir": "s2c" | "c2s", "message": { /* deviceRequest | deviceResponse | deviceEvent */ }}
{"dir": "s2c" | "c2s", "raw": "<exact JSON text of the wire message>"}
{"dir": "s2c" | "c2s", "frame": {"header": {version, flags, channel, requestId, seq},
                                 "hex": "…", "payloadHex": "…"?,
                                 "payloadFill": {"byte": 0, "length": 65536}?}}
```

with at most one flag (flags are `true` when present):

- `"ignored": true` — the step targets an id that is not live for its
  receiver (never requested, retired by cancel or terminal, or a
  duplicate/older request id below the client's high-water mark). The
  receiver drops it with no effect, **whatever its direction or validity**:
  liveness is checked before direction (decision D8). A runner **must**
  classify every flagged step as stale and every stale step as flagged.
- `"expectViolation": "<category>"` — the step is a protocol violation the
  runner must detect, in exactly this category. It need not be the last
  step.
- `"reaction": true` — the step immediately after a request-level
  violation: the detecting endpoint's required reaction (below).

A frame's bytes are `hex` followed by `payloadFill.length` copies of
`payloadFill.byte` when present (bulk transcripts stay small); `payloadHex`,
when present, must equal the bytes after the 12-byte header.

**Connection model.** A runner tracks one connection:

- the **live selection** starts as the `ack`'s `(name, version)` pairs, and
  the ack is its **ceiling for the whole connection** (RFC 001 §2.2): every
  `core.capabilities` snapshot event on the live core stream recomputes it
  as the ack's entries whose revision the snapshot lists (ack ∩ snapshot).
  A snapshot narrows the selection or restores an entry it withdrew; it never
  widens it, even to a capability `serverCapabilities` offers but the ack
  lacks (`violation-snapshot-cannot-widen-ack`). The ack was negotiated
  against `serverCapabilities` (every ack entry is one of its revisions), so
  the handshake rules — first server entry per name, highest mutual declared
  revision, no binary plane when the ack says `binary: false` — are already
  applied. A snapshot omitting `core.capabilities` does not end
  the stream; `core.capabilities@1` stays requestable (for a planned reopen);
- **app requests only after** a `core.capabilities` stream was opened; at
  most **one live** core stream (a planned reopen cancels the old one first);
  a **terminal** on the live core stream closes the device connection;
- a request naming a revision outside the live selection or the registry is
  refused with `unsupported`;
- `activationId` never goes backwards per `moduleInstanceId`.

Transcripts in this directory open `core.capabilities` as their first step
(a one-step prelude, id 1) unless they test the opening itself.

**Violation categories**:

| Category | Meaning |
|---|---|
| `malformed` | Strict decoding fails: the JSON limits, closed typed decoding, canonical shapes, `beyondSchema` rules; or a frame header with an unknown version or nonzero flags. |
| `invalidPayload` | Params/result/event do not fit the selected revision (typed schema or registry bounds: lifetime not allowed, `timeoutMs`/`initialCredit` above the revision maximum, download `initialCredit` ≠ 0, item bytes above `maxItemBytes`), or a `progress` event that goes back to `pendingConsent` after `running` or after data. |
| `unsupported` | A request for a revision the registry does not declare or that is not in the live selection (removed by a snapshot, not negotiated — even if a later snapshot lists it —, binary plane on a `binary: false` connection). |
| `direction` | Sent by the wrong endpoint: requests/cancel/`renewLease` are s2c; responses, capability events and `leaseAck` c2s; `grant` from the data receiver; `paused` and frames from the data sender. Only judged for live ids. |
| `credit` | Data (bytes, or events on JSON streams) beyond granted credit; outstanding credit above `maxOutstandingCredit`; `grant`/`paused` on a revision without a data plane; `paused` repeating the current state; data from a sender that reported `paused: true`. |
| `lease` | A first `renewLease` other than 1; a `renewLease` that does not strictly increase; a `leaseAck` for a sequence never sent on that request. Repeated/older acks of sent sequences are legal and refresh nothing. |
| `sequence` | Per-channel `seq` not starting at 0, gap on a lossless channel, repeat, decrease, or wrap (`frames.json` `sequences`). |
| `blob` | Bytes before `blobStart` or on an unannounced channel; a zero-length frame (a zero-byte item sends no frames); duplicate or out-of-`maxCount` channel; a `blobStart` whose metadata does not fit the request's params (`camera.capture@1`: a `photo` item is `image/jpeg`/`image/heic`, a `video` item `video/mp4`/`video/quicktime`/`video/webm`; the Rust reference is `validate_blob_start_for_request`); chunk above 64 KiB; bytes beyond a declared size or beyond `maxItemBytes`; a success terminal whose item set, `contentType`, byte counts (actual = received = declared when declared) or SHA-256 differ from the announcements and received bytes (uploads), or that arrives before the declared download bytes/hash (downloads). |
| `owner` | A request whose `activationId` is lower than one already seen for its `moduleInstanceId`. |
| `connection` | The connection model breaks: an app request before any `core.capabilities` stream, a second live core stream, a terminal on the live core stream. The device connection closes: it is always the last step. |

**Reactions** (decision D8). After a violation:

- `malformed` with no attributable request (JSON limits, bad frame header):
  no reaction and no state change; the request its id seems to name stays
  live. An endpoint MAY close the connection after repeated violations.
- `connection`: the device connection closes; nothing follows.
- Every other violation (including an attributable `malformed` message) is
  request-level. The next step is the reaction, flagged `"reaction": true`:
  - detected by the **client** (an s2c step): the client's terminal
    `deviceResponse` for that id with `error.code` `unsupported` (category
    `unsupported`) or `invalidParams` (everything else);
  - detected by the **server** (a c2s step): the server's
    `{"control":{"cancel":true}}` for that id; it settles the request locally
    with `invalidParams`. When the offending c2s step is itself the client's
    terminal `deviceResponse`, the server settles locally and **no** reaction
    step follows.

  The id is then retired on both sides; later messages for it are `ignored`.
  A runner acting as one endpoint feeds the other side's steps and asserts its
  SDK emits the reaction.

Every step's `message` must also round-trip and validate against the exported
schemas (`envelope-v1` for every message; the selected revision's
`$defs/params|result|event` for payloads). Timing (lease expiry, deadlines,
the 5 s cadence) and the per-connection retained-bytes budget (host
configuration; exceeding it terminates with `throttled`) are not observable in
this format: transcripts show only the resulting messages.

### Handshake-selection fixtures

`hello` present; pins `select_device_ack`:

```jsonc
{"name", "description", "hello": { /* hello.device */ }, "serverProtocolVersions": [...],
 "serverBinary": bool, "serverCapabilities": [...],
 "expectAck": { /* sessionAck.device */ } | null}
```

The table in `conformance/selection.json` is the fuller set of selection cases.

## `frames.json` — golden binary frame bytes

The canonical header bytes every per-SDK native codec must reproduce exactly,
plus invalid frames with their required classification: `shortHeader`
(under 12 bytes) is dropped without effect; `violation-*` (unknown version,
nonzero flags) is a connection-level `malformed` violation that never
terminates a request (decision D3). Header-only goldens are codec vectors; on
the wire a zero-length payload is a `blob` violation (decision D2).
`sequences` holds the receiver-side per-channel `seq` rule cases (`overflow`
`pause` = lossless, `dropOldest` = forward gaps allowed; `valid: false` means
the last seq is the violation).

## Reference runner

`hypen-engine-rs/tests/test_device_transcripts.rs` is the stateful reference
model (connection model, live/retired ids per endpoint, client high-water
mark, directions, reactions, credit, lease, progress, per-channel seq, byte
totals and SHA-256 against items, registry bounds, JSON Schema validation of
every message, strict fixture-format validation).
`HYPEN_DEVICE_TRANSCRIPTS=<dir> cargo test --test test_device_transcripts`
replays another directory. `hypen-engine-rs/tests/test_device_conformance.rs`
runs the `conformance/` corpus and a differential fuzz of the strict decoders
against the schemas. Per-SDK runners mirror both.

## Schemas and registry

The JSON Schemas these fixtures validate against, and the capability registry
as data (`registry-v1.json`: every revision's mode, data plane, consent,
overflow, lifetimes and limits), are exported from the Rust declarations into
`../../schema/device/` (`cargo test --features schema-export` in
`hypen-engine-rs`, which CI runs; regenerate with `HYPEN_WRITE_SCHEMAS=1`).
SDK registries should be compared field-by-field against `registry-v1.json`.

## Regenerating

Everything under this directory except this README is generated by the
scripts in `tools/`; `gen_transcripts.py` owns `transcripts/` entirely and
deletes files it no longer writes:

```bash
python3 engine-compatibility-tests/fixtures/device/tools/gen_conformance.py
python3 engine-compatibility-tests/fixtures/device/tools/gen_selection.py
python3 engine-compatibility-tests/fixtures/device/tools/gen_transcripts.py
python3 engine-compatibility-tests/fixtures/device/tools/gen_frames.py
```

CI re-runs all four and fails on any diff (`git diff --exit-code`). The
schemas and `registry-v1.json` are exported from the Rust source of truth
(`cargo test --features schema-export`, see `hypen-engine-rs`). Regenerate,
then run every SDK's conformance tests.
